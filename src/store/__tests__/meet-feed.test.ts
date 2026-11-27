import { describe, expect, it } from 'vitest';
import { FeedSession, OWN_SEQ, decodeIncoming, decodeOutgoing, encodeLanguage, findDeviceNames } from '../meet-feed';

// Protobuf building blocks, to write Meet's messages the way its server does (field map: meet-feed.ts).
const varint = (n: number) => {
  const o: number[] = [];
  while (n > 127) {
    o.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  o.push(n);
  return o;
};
const enc = new TextEncoder();
const bytes = (f: number, b: number[] | Uint8Array) => [(f << 3) | 2, ...varint(b.length), ...b];
const text = (f: number, s: string) => bytes(f, [...enc.encode(s)]);
const int = (f: number, n: number) => [f << 3, ...varint(n)];

const DEVICE = 'spaces/abc/devices/zach';
function captionMessage(id: number, version: number, said: string, final = false, device = DEVICE): Uint8Array {
  const caption = [...(final ? int(2, 1) : []), ...text(3, said), ...text(4, 'en-US'), ...text(6, device)];
  const utterance = [...int(1, id), ...int(2, version), ...bytes(3, caption)];
  return new Uint8Array(bytes(1, [...bytes(1, utterance), ...bytes(6, int(1, 1_795_000_000))]));
}
const replyMessage = (seq: number) => new Uint8Array(bytes(1, bytes(2, [...int(1, seq), ...text(3, '')])));
const namesMessage = (device: string, name: string) =>
  new Uint8Array(bytes(4, bytes(2, [...text(1, device), ...text(2, name)])));

describe("Meet's caption feed messages", () => {
  it('reads a caption update: utterance, version, final flag, words and the speaker device', () => {
    expect(decodeIncoming(captionMessage(7, 3, 'ship it Friday', true))).toEqual({
      kind: 'captions',
      utterances: [{ id: '7', version: 3, final: true, text: 'ship it Friday', lang: 'en-US', device: DEVICE }],
    });
    expect(decodeIncoming(replyMessage(OWN_SEQ + 1))).toEqual({ kind: 'reply', seq: OWN_SEQ + 1 });
    expect(decodeIncoming(new Uint8Array([0xff, 0xff]))).toBeNull();
  });

  it("writes the CC button's request, and reads it back (on in a language, or off)", () => {
    expect(decodeOutgoing(encodeLanguage(OWN_SEQ + 2, 'en-US'))).toEqual({
      kind: 'language',
      seq: OWN_SEQ + 2,
      lang: 'en-US',
    });
    expect(decodeOutgoing(encodeLanguage(4, ''))).toEqual({ kind: 'language', seq: 4, lang: '' });
  });

  it('finds participant names by device id, however deep', () => {
    expect(findDeviceNames(namesMessage(DEVICE, 'Zach Kostic'))).toEqual([[DEVICE, 'Zach Kostic']]);
  });
});

describe('a notes session on the feed', () => {
  function setup() {
    const sent: Uint8Array[] = [];
    let now = 0;
    const session = new FeedSession('k1', 'en-US', {
      send: (_label, b) => sent.push(b),
      tileNames: () => new Map([['spaces/abc/devices/aaron', 'Aaron Santos']]),
      inCall: () => true,
      now: () => now,
    });
    return { session, sent, later: (ms: number) => (now += ms) };
  }

  it('asks for captions once the channel opens, and is live when they come', () => {
    const { session, sent } = setup();
    session.hooked();
    expect(session.feed).toBe('waiting');
    session.opened('captions_v2');
    expect(decodeOutgoing(sent[0])).toMatchObject({ kind: 'language', lang: 'en-US' });
    expect(session.feed).toBe('asked');
    session.message('captions_v2', 'in', replyMessage(OWN_SEQ + 1));
    expect(session.feed).toBe('live');
  });

  it("names the speaker from Meet's names, else the tiles, and reports only what changed", () => {
    const { session } = setup();
    session.hooked();
    session.opened('captions_v2');
    session.message('collections', 'in', namesMessage(DEVICE, 'Zach Kostic'));
    session.message('captions_v2', 'in', captionMessage(1, 1, 'so the'));
    session.message('captions_v2', 'in', captionMessage(1, 2, 'so the call moved'));
    session.message('captions_v2', 'in', captionMessage(2, 1, 'got it', true, 'spaces/abc/devices/aaron'));
    expect(session.flush().utterances).toEqual([
      { id: '1', speaker: 'Zach Kostic', text: 'so the call moved', final: false },
      { id: '2', speaker: 'Aaron Santos', text: 'got it', final: true },
    ]);
    // An older version arriving late changes nothing.
    session.message('captions_v2', 'in', captionMessage(1, 1, 'so the'));
    expect(session.flush().utterances).toEqual([]);
  });

  it("notices Meet's own CC request (to ask again), and a page with no hook", () => {
    const { session, later } = setup();
    expect(session.message('captions_v2', 'out', encodeLanguage(3, ''))).toBe(true);
    expect(session.message('captions_v2', 'out', encodeLanguage(OWN_SEQ + 1, 'en-US'))).toBe(false);
    later(2500);
    expect(session.flush().feed).toBe('no-hook');
  });
});
