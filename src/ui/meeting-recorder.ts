// The notetaker's recording (Aaron 2026-11-27: video + audio to Google Drive): the Meet tab and the person's
// microphone, mixed into one sound track, recorded as WebM and sent to Drive in pieces (store/drive-upload.ts). It
// normally runs in the offscreen document, so closing the side panel doesn't stop it (Recall.ai's, CallScribe's and
// Meet Transcriber's extensions all record there); only when Chrome won't hand the worker the tab does the panel record
// it through Chrome's share picker. While Meet's caption feed is down it also cuts the sound into 15-second clips,
// which the worker transcribes instead.
//
// It also keeps the last 150 s of the call's sound at 16 kHz, so the worker can have each speaker's turn transcribed
// by OpenAI (better words than Meet's own captions, Aaron 2026-11-27), named from Meet's caption feed.
//
// RecorderHost runs recordings in whichever page holds them, on the worker's word (src/extension/meet-notes.ts):
//   worker -> here   { target: 'recorder', type: 'rec-stop', key } -> { fileId } | { error }
//                    { target: 'recorder', type: 'rec-transcribe', key, on }
//                    { target: 'recorder', type: 'rec-slice', key, from, to } -> { wav } | {}   (ms, this clock)
//   here -> worker   { type: 'kai-rec', key, event: 'progress', recorded, sent }
//                    { type: 'kai-rec', key, event: 'clip', at, wav }   (base64, 16 kHz mono WAV)
//                    { type: 'kai-rec', key, event: 'ended' }            (the tab or the sharing ended)
import { ResumableUpload, recordingMime } from '@src/store/drive-upload';
import { encodeWav, toWav } from './voice';

/** A clip for the transcription fallback. */
export const CLIP_MS = 15_000;
/** The call's sound kept for transcribing turns, at speech models' rate. */
const SOUND_KEEP_MS = 150_000;
const SOUND_RATE = 16_000;

/** Averages a chunk down to 16 kHz (speech needs no more). */
export function downsample(chunk: Float32Array, rate: number): Float32Array {
  const ratio = rate / SOUND_RATE;
  if (ratio <= 1) return chunk.slice();
  const out = new Float32Array(Math.floor(chunk.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(chunk.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += chunk[j];
    out[i] = sum / (b - a);
  }
  return out;
}

/** Pieces of 16 kHz sound, each ending at `end` (ms): the samples between `from` and `to`, or null under 0.3 s. */
export function soundBetween(
  pieces: Array<{ end: number; samples: Float32Array }>,
  from: number,
  to: number,
): Float32Array | null {
  const parts: Float32Array[] = [];
  for (const piece of pieces) {
    const start = piece.end - (piece.samples.length / SOUND_RATE) * 1000;
    if (piece.end <= from || start >= to) continue;
    const a = Math.max(0, Math.round(((from - start) / 1000) * SOUND_RATE));
    const b = Math.min(piece.samples.length, Math.round(((to - start) / 1000) * SOUND_RATE));
    if (b > a) parts.push(piece.samples.subarray(a, b));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (total < SOUND_RATE * 0.3) return null;
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface RecorderMessage {
  type: 'kai-rec';
  key: string;
  event: 'progress' | 'clip' | 'ended';
  recorded?: number;
  sent?: number;
  at?: string;
  wav?: string;
}

export class MeetingRecorder {
  readonly withMic: boolean;
  readonly #tab: MediaStream;
  readonly #mic: MediaStream | null;
  readonly #audio: AudioContext;
  readonly #mix: MediaStreamAudioDestinationNode;
  readonly #upload: ResumableUpload;
  readonly #recorder: MediaRecorder;
  readonly #ended: Array<() => void> = [];
  readonly #sound: Array<{ end: number; samples: Float32Array }> = [];
  #clips: { stop(): void } | null = null;
  #stopping: Promise<string> | null = null;

  /** `playBack`: tab capture silences the tab for the person, so the meeting is played back to them. */
  constructor(options: { tab: MediaStream; mic: MediaStream | null; uploadUrl: string; playBack: boolean }) {
    this.#tab = options.tab;
    this.#mic = options.mic;
    this.withMic = Boolean(options.mic);
    this.#audio = new AudioContext();
    this.#mix = this.#audio.createMediaStreamDestination();
    const sources: AudioNode[] = [];
    if (this.#tab.getAudioTracks().length) {
      const meeting = this.#audio.createMediaStreamSource(new MediaStream(this.#tab.getAudioTracks()));
      meeting.connect(this.#mix);
      if (options.playBack) meeting.connect(this.#audio.destination);
      sources.push(meeting);
    }
    if (this.#mic) {
      const mic = this.#audio.createMediaStreamSource(this.#mic);
      mic.connect(this.#mix);
      sources.push(mic);
    }
    void this.#keepSound(sources).catch(() => undefined);
    this.#upload = new ResumableUpload(options.uploadUrl);
    const mimeType = recordingMime();
    this.#recorder = new MediaRecorder(
      new MediaStream([...this.#tab.getVideoTracks(), ...this.#mix.stream.getAudioTracks()]),
      { mimeType, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 },
    );
    this.#recorder.ondataavailable = event => {
      if (event.data.size) this.#upload.add(event.data);
    };
    this.#recorder.start(4000);
    this.#tab.getVideoTracks()[0]?.addEventListener('ended', () => {
      for (const callback of this.#ended.splice(0)) callback();
    });
  }

  /** Taps the mixed sound (the voice agent's worklet) and keeps the last 150 s of it at 16 kHz. */
  async #keepSound(sources: AudioNode[]): Promise<void> {
    if (!sources.length) return;
    await this.#audio.audioWorklet.addModule(chrome.runtime.getURL('/voice-capture-worklet.js'));
    const tap = new AudioWorkletNode(this.#audio, 'voice-capture');
    for (const source of sources) source.connect(tap);
    // A worklet runs only when something pulls on it: a silent path to the speakers.
    const silent = this.#audio.createGain();
    silent.gain.value = 0;
    tap.connect(silent).connect(this.#audio.destination);
    tap.port.onmessage = event => {
      const now = Date.now();
      this.#sound.push({ end: now, samples: downsample(event.data as Float32Array, this.#audio.sampleRate) });
      while (this.#sound.length && this.#sound[0].end < now - SOUND_KEEP_MS) this.#sound.shift();
    };
  }

  /** The call's sound between two times (ms, this machine's clock) as 16 kHz WAV; null when none is kept. */
  slice(from: number, to: number): Uint8Array | null {
    const samples = soundBetween(this.#sound, from, to);
    return samples ? encodeWav(samples, SOUND_RATE) : null;
  }

  get recordedBytes(): number {
    return this.#upload.recordedBytes;
  }

  get sentBytes(): number {
    return this.#upload.sentBytes;
  }

  /** Called once when the capture ends on its own (the tab closed, or sharing was stopped). */
  onEnded(callback: () => void): void {
    this.#ended.push(callback);
  }

  /** Starts (or stops, with null) cutting the sound into clips for transcription. */
  clips(onClip: ((wav: Uint8Array, at: string) => void) | null): void {
    this.#clips?.stop();
    this.#clips = null;
    if (!onClip) return;
    const stream = new MediaStream(this.#mix.stream.getAudioTracks());
    let on = true;
    let current: MediaRecorder | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const next = () => {
      if (!on || this.#stopping) return;
      const at = new Date().toISOString();
      const parts: Blob[] = [];
      const clip = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 });
      current = clip;
      clip.ondataavailable = event => {
        if (event.data.size) parts.push(event.data);
      };
      clip.onstop = () => {
        if (parts.length)
          void toWav(new Blob(parts, { type: 'audio/webm' })).then(
            wav => onClip(wav, at),
            () => undefined,
          );
        next();
      };
      clip.start();
      timer = setTimeout(() => clip.state !== 'inactive' && clip.stop(), CLIP_MS);
    };
    next();
    this.#clips = {
      stop() {
        on = false;
        if (timer) clearTimeout(timer);
        if (current && current.state !== 'inactive') current.stop();
      },
    };
  }

  /** Stops recording, sends the rest, and answers Drive's file id. */
  stop(): Promise<string> {
    this.#stopping ??= new Promise<void>(resolve => {
      this.#clips?.stop();
      if (this.#recorder.state === 'inactive') return resolve();
      this.#recorder.onstop = () => resolve();
      this.#recorder.stop();
    }).then(() => {
      for (const track of [...this.#tab.getTracks(), ...(this.#mic?.getTracks() ?? [])]) track.stop();
      void this.#audio.close();
      return this.#upload.finish();
    });
    return this.#stopping;
  }
}

/** Base64 of bytes, for a runtime message (which carries JSON only). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The person's microphone, when Bash AI may use it; null otherwise (the recording goes on without it). */
export function openMicrophone(): Promise<MediaStream | null> {
  return navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .catch(() => null);
}

/** The recordings this page holds, run on the worker's word and reported to it. */
export class RecorderHost {
  readonly #recordings = new Map<string, { recorder: MeetingRecorder; progress: ReturnType<typeof setInterval> }>();

  get size(): number {
    return this.#recordings.size;
  }

  has(key: string): boolean {
    return this.#recordings.has(key);
  }

  add(key: string, recorder: MeetingRecorder): void {
    const tell = (message: Omit<RecorderMessage, 'type' | 'key'>) =>
      void chrome.runtime.sendMessage({ type: 'kai-rec', key, ...message }).catch(() => undefined);
    const progress = setInterval(
      () => tell({ event: 'progress', recorded: recorder.recordedBytes, sent: recorder.sentBytes }),
      2000,
    );
    recorder.onEnded(() => tell({ event: 'ended' }));
    this.#recordings.set(key, { recorder, progress });
  }

  /** A worker command for a recording here: answers true when the reply comes later. */
  handle(
    message: { target?: string; type?: string; key?: string; on?: boolean },
    reply: (answer: unknown) => void,
  ): boolean | undefined {
    if (message?.target !== 'recorder' || !message.key) return undefined;
    const key = message.key;
    const held = this.#recordings.get(key);
    if (!held) return undefined;
    if (message.type === 'rec-transcribe') {
      held.recorder.clips(
        message.on
          ? (wav, at) =>
              void chrome.runtime
                .sendMessage({ type: 'kai-rec', key, event: 'clip', at, wav: toBase64(wav) })
                .catch(() => undefined)
          : null,
      );
      reply({ ok: true });
      return undefined;
    }
    if (message.type === 'rec-slice') {
      const { from, to } = message as { from?: number; to?: number };
      const wav = typeof from === 'number' && typeof to === 'number' ? held.recorder.slice(from, to) : null;
      reply(wav ? { wav: toBase64(wav) } : {});
      return undefined;
    }
    if (message.type === 'rec-stop') {
      clearInterval(held.progress);
      held.recorder.stop().then(
        fileId => {
          this.#recordings.delete(key);
          reply({ fileId });
        },
        (error: Error) => {
          this.#recordings.delete(key);
          reply({ error: error.message });
        },
      );
      return true;
    }
    return undefined;
  }
}
