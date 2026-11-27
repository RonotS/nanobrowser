// The notetaker's recording (Aaron 2026-11-27: video + audio + transcript, saved to Command Center + Google Drive).
// It records the person's Google Meet tab (what everyone else says and shows) and their own microphone, mixed, as WebM,
// and sends it to Google Drive in pieces while the call goes on (a Drive resumable upload Command Center opens), so a
// long meeting never piles up in the browser. It lives in the side panel, like the notes: closing the panel ends it.
//
// The tab: chrome.tabCapture first (no picker). Chrome allows that only once the person has invoked the extension on
// the tab, and its docs don't say whether a side-panel click counts, so when it refuses, Chrome's own "share a tab"
// picker is the fallback (the person picks the Meet tab, with its audio).
import { finishRecordingUpload, startRecordingUpload } from '@src/store/command-center';

/** Drive takes a resumable upload's pieces in multiples of 256 KiB (all but the last). */
export const GRAIN = 256 * 1024;
/** Pieces of 8 MiB: few requests, and little held in memory. */
export const PIECE = 32 * GRAIN;

/** How much of what is buffered to send now: whole 256 KiB grains once 8 MiB has gathered, everything at the end. */
export function sendable(buffered: number, final: boolean): number {
  if (final) return buffered;
  return buffered >= PIECE ? Math.floor(buffered / GRAIN) * GRAIN : 0;
}

/** Drive's Content-Range for a piece: "bytes 0-8388607/*", or with the total on the last one. */
export function contentRange(start: number, length: number, total: number | null): string {
  if (length === 0) return `bytes */${total ?? '*'}`;
  return `bytes ${start}-${start + length - 1}/${total ?? '*'}`;
}

/** The first byte Drive does not have yet, from a 308's Range header ("bytes=0-8388607"). */
export function confirmedUpTo(range: string | null): number {
  const m = /bytes=0-(\d+)/.exec(range ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

/**
 * Sends a recording to a Drive resumable upload, in order, one piece at a time. A piece that fails is tried again
 * (after asking Drive how much it has) up to four times.
 */
export class ResumableUpload {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  #pending: Blob = new Blob([]);
  #sent = 0;
  #chain: Promise<void> = Promise.resolve();
  #error: Error | null = null;
  fileId: string | null = null;

  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.#url = url;
    this.#fetch = fetchImpl;
  }

  get sentBytes(): number {
    return this.#sent;
  }

  get error(): Error | null {
    return this.#error;
  }

  add(data: Blob): void {
    this.#pending = new Blob([this.#pending, data]);
    this.#chain = this.#chain.then(() => this.#pump(false));
  }

  /** Sends what is left as the last piece; resolves with Drive's file id. */
  async finish(): Promise<string> {
    this.#chain = this.#chain.then(() => this.#pump(true));
    await this.#chain;
    if (this.#error) throw this.#error;
    if (!this.fileId) throw new Error('Drive did not confirm the recording.');
    return this.fileId;
  }

  async #pump(final: boolean): Promise<void> {
    if (this.#error) return;
    for (;;) {
      const size = sendable(this.#pending.size, final);
      if (!size && !(final && !this.fileId)) return;
      const piece = this.#pending.slice(0, size);
      const total = final && size === this.#pending.size ? this.#sent + size : null;
      try {
        await this.#put(piece, total);
      } catch (error) {
        this.#error = error as Error;
        return;
      }
      if (total !== null) return;
    }
  }

  /**
   * Sends one piece. Drive answers 308 with how much it has (`Range`) while the upload goes on, and 200/201 with the
   * file when the last piece (with the total) is in. On a network error or a 5xx/429 it asks Drive how much it has and
   * sends the rest, four tries at most; another 4xx ends the upload.
   */
  async #put(piece: Blob, total: number | null): Promise<void> {
    const accept = (upTo: number) => {
      const took = Math.max(0, upTo - this.#sent);
      this.#pending = this.#pending.slice(took);
      this.#sent += took;
      return took;
    };
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.#fetch(this.#url, {
          method: 'PUT',
          headers: { 'Content-Range': contentRange(this.#sent, piece.size, total) },
          body: piece,
        });
        if (res.status === 308) {
          const took = accept(confirmedUpTo(res.headers.get('range')));
          if (total === null) return; // more pieces follow; the pump sends what Drive didn't keep
          piece = piece.slice(took); // the last piece: Drive kept part of it, send the rest
          continue;
        }
        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as { id?: string };
          accept(this.#sent + piece.size);
          this.fileId = body.id ?? null;
          return;
        }
        if (res.status < 500 && res.status !== 429)
          throw new RefusedError(`Drive refused the recording (${res.status}).`);
        throw new Error(`Drive answered ${res.status}.`);
      } catch (error) {
        if (attempt >= 4 || error instanceof RefusedError) throw error;
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        // Ask Drive what it has before sending again.
        const status = await this.#fetch(this.#url, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes */${total ?? '*'}` },
        }).catch(() => null);
        if (status?.status === 308) {
          piece = piece.slice(accept(confirmedUpTo(status.headers.get('range'))));
          if (total === null && !piece.size) return;
        } else if (status?.ok) {
          this.fileId = ((await status.json().catch(() => ({}))) as { id?: string }).id ?? null;
          accept(this.#sent + this.#pending.size);
          return;
        }
      }
    }
  }
}

class RefusedError extends Error {}

/** The best WebM the browser records. */
export function recordingMime(
  isTypeSupported: (type: string) => boolean = t => MediaRecorder.isTypeSupported(t),
): string {
  for (const type of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

export interface ActiveRecording {
  /** How the tab was captured: straight (tab) or through Chrome's share picker. */
  mode: 'tab' | 'picker';
  withMic: boolean;
  startedAt: number;
  sentBytes(): number;
  /** Calls back once when the capture ends on its own (the tab closed, or sharing was stopped). */
  onEnded(callback: () => void): void;
  /** Stops recording, sends the rest, and gives the saved file's Drive link. */
  stop(): Promise<{ url: string; name: string }>;
}

let current: ActiveRecording | null = null;

/** The recording going on in this panel, if any. */
export function activeRecording(): ActiveRecording | null {
  return current;
}

/**
 * Starts recording a Meet tab. Call it straight from the click (tab capture and the picker both need it), before
 * anything else awaits.
 */
export async function startRecording(tabId: number, title: string): Promise<ActiveRecording> {
  if (current) throw new Error('A recording is already going on.');
  let tab: MediaStream;
  let mode: ActiveRecording['mode'];
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    tab = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: 1280,
          maxHeight: 720,
          maxFrameRate: 15,
        },
      },
    } as unknown as MediaStreamConstraints);
    mode = 'tab';
  } catch {
    tab = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 15 },
      audio: true,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
    } as unknown as DisplayMediaStreamOptions);
    mode = 'picker';
  }
  const mic = await navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .catch(() => null);

  // One audio track: the meeting and the person's own voice.
  const audio = new AudioContext();
  const mix = audio.createMediaStreamDestination();
  if (tab.getAudioTracks().length) {
    const meeting = audio.createMediaStreamSource(new MediaStream(tab.getAudioTracks()));
    meeting.connect(mix);
    // Tab capture silences the tab for the person; play the meeting back to them.
    if (mode === 'tab') meeting.connect(audio.destination);
  }
  if (mic) audio.createMediaStreamSource(mic).connect(mix);

  const stopTracks = () => {
    for (const track of [...tab.getTracks(), ...(mic?.getTracks() ?? [])]) track.stop();
    void audio.close();
  };

  const mimeType = recordingMime();
  let upload: ResumableUpload;
  try {
    const session = await startRecordingUpload({ title, startedAt: new Date().toISOString(), mimeType });
    upload = new ResumableUpload(session.uploadUrl);
  } catch (error) {
    stopTracks();
    throw error;
  }
  const recorder = new MediaRecorder(new MediaStream([...tab.getVideoTracks(), ...mix.stream.getAudioTracks()]), {
    mimeType,
    videoBitsPerSecond: 1_000_000,
    audioBitsPerSecond: 64_000,
  });
  recorder.ondataavailable = event => {
    if (event.data.size) upload.add(event.data);
  };
  recorder.start(4000);

  const ended: Array<() => void> = [];
  tab.getVideoTracks()[0]?.addEventListener('ended', () => {
    for (const callback of ended.splice(0)) callback();
  });
  let stopping: Promise<{ url: string; name: string }> | null = null;
  const recording: ActiveRecording = {
    mode,
    withMic: Boolean(mic),
    startedAt: Date.now(),
    sentBytes: () => upload.sentBytes,
    onEnded: callback => {
      ended.push(callback);
    },
    stop() {
      stopping ??= new Promise<void>(resolve => {
        if (recorder.state === 'inactive') return resolve();
        recorder.onstop = () => resolve();
        recorder.stop();
      })
        .then(async () => {
          stopTracks();
          const fileId = await upload.finish();
          return finishRecordingUpload(fileId);
        })
        .finally(() => {
          if (current === recording) current = null;
        });
      return stopping;
    },
  };
  current = recording;
  return recording;
}
