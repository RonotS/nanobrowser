import { describe, expect, it, vi } from 'vitest';

vi.mock('@src/store/command-center', () => ({ startRecordingUpload: vi.fn(), finishRecordingUpload: vi.fn() }));

import { GRAIN, PIECE, ResumableUpload, confirmedUpTo, contentRange, recordingMime, sendable } from '../recorder';

/** A fake Drive resumable upload: keeps what it is sent, answers 308 with Range, and 200 with the file at the end. */
function fakeDrive(options: { failFirst?: number; keepAtMost?: number } = {}) {
  let have = 0;
  let failures = options.failFirst ?? 0;
  const puts: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const range = (init.headers as Record<string, string>)['Content-Range'];
    puts.push(range);
    const body = init.body as Blob | undefined;
    const status = /^bytes \*\/(\*|\d+)$/.exec(range);
    if (status) {
      if (status[1] !== '*' && Number(status[1]) === have)
        return new Response(JSON.stringify({ id: 'file-1' }), { status: 200 });
      return new Response(null, { status: 308, headers: have ? { range: `bytes=0-${have - 1}` } : {} });
    }
    if (failures > 0) {
      failures -= 1;
      throw new TypeError('network down');
    }
    const m = /^bytes (\d+)-(\d+)\/(\*|\d+)$/.exec(range)!;
    expect(Number(m[1])).toBe(have);
    const size = body?.size ?? 0;
    have += Math.min(size, options.keepAtMost ?? size);
    if (m[3] !== '*' && have === Number(m[3])) return new Response(JSON.stringify({ id: 'file-1' }), { status: 200 });
    return new Response(null, { status: 308, headers: { range: `bytes=0-${have - 1}` } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, puts, received: () => have };
}

describe('pieces for Drive', () => {
  it('sends whole 256 KiB grains once 8 MiB has gathered, and everything at the end', () => {
    expect(sendable(PIECE - 1, false)).toBe(0);
    expect(sendable(PIECE + 100, false)).toBe(PIECE);
    expect(sendable(PIECE + GRAIN + 5, false)).toBe(PIECE + GRAIN);
    expect(sendable(123, true)).toBe(123);
  });

  it("writes Drive's Content-Range and reads its Range", () => {
    expect(contentRange(0, PIECE, null)).toBe(`bytes 0-${PIECE - 1}/*`);
    expect(contentRange(PIECE, 10, PIECE + 10)).toBe(`bytes ${PIECE}-${PIECE + 9}/${PIECE + 10}`);
    expect(contentRange(5, 0, 5)).toBe('bytes */5');
    expect(confirmedUpTo('bytes=0-8388607')).toBe(PIECE);
    expect(confirmedUpTo(null)).toBe(0);
  });

  it('picks the best WebM the browser records', () => {
    expect(recordingMime(t => t === 'video/webm;codecs=vp8,opus')).toBe('video/webm;codecs=vp8,opus');
    expect(recordingMime(() => false)).toBe('video/webm');
  });
});

describe('the resumable upload', () => {
  const blob = (size: number) => new Blob([new Uint8Array(size)]);

  it('sends 8 MiB pieces while recording, then the rest with the total, and gets the file id', async () => {
    const drive = fakeDrive();
    const upload = new ResumableUpload('https://upload/session', drive.fetchImpl);
    upload.add(blob(PIECE / 2));
    upload.add(blob(PIECE / 2 + 1000));
    upload.add(blob(5000));
    await expect(upload.finish()).resolves.toBe('file-1');
    expect(drive.received()).toBe(PIECE + 6000);
    expect(drive.puts).toEqual([`bytes 0-${PIECE - 1}/*`, `bytes ${PIECE}-${PIECE + 5999}/${PIECE + 6000}`]);
    expect(upload.sentBytes).toBe(PIECE + 6000);
  });

  it('a recording under 8 MiB goes in one last piece', async () => {
    const drive = fakeDrive();
    const upload = new ResumableUpload('https://upload/session', drive.fetchImpl);
    upload.add(blob(1234));
    await expect(upload.finish()).resolves.toBe('file-1');
    expect(drive.puts).toEqual(['bytes 0-1233/1234']);
  });

  it("keeps what Drive didn't take and sends it next", async () => {
    const drive = fakeDrive({ keepAtMost: PIECE - GRAIN });
    const upload = new ResumableUpload('https://upload/session', drive.fetchImpl);
    upload.add(blob(PIECE));
    upload.add(blob(10));
    await expect(upload.finish()).resolves.toBe('file-1');
    expect(drive.received()).toBe(PIECE + 10);
  });

  it('after a network error it asks Drive what it has and carries on', async () => {
    vi.useFakeTimers();
    const drive = fakeDrive({ failFirst: 1 });
    const upload = new ResumableUpload('https://upload/session', drive.fetchImpl);
    upload.add(blob(100));
    const done = upload.finish();
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe('file-1');
    expect(drive.puts[0]).toBe('bytes 0-99/100');
    expect(drive.puts[1]).toBe('bytes */100');
    vi.useRealTimers();
  });

  it('a refusal (4xx) ends the upload with the reason', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const upload = new ResumableUpload('https://upload/session', fetchImpl);
    upload.add(new Blob([new Uint8Array(10)]));
    await expect(upload.finish()).rejects.toThrow('Drive refused the recording (403).');
  });
});
