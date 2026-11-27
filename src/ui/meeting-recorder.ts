// The notetaker's recording (Aaron 2026-11-27: video + audio to Google Drive): the Meet tab and the person's
// microphone, mixed into one sound track, recorded as WebM and sent to Drive in pieces (store/drive-upload.ts). It
// normally runs in the offscreen document, so closing the side panel doesn't stop it (Recall.ai's, CallScribe's and
// Meet Transcriber's extensions all record there); only when Chrome won't hand the worker the tab does the panel record
// it through Chrome's share picker. While Meet's caption feed is down it also cuts the sound into 15-second clips,
// which the worker transcribes instead.
//
// RecorderHost runs recordings in whichever page holds them, on the worker's word (src/extension/meet-notes.ts):
//   worker -> here   { target: 'recorder', type: 'rec-stop', key } -> { fileId } | { error }
//                    { target: 'recorder', type: 'rec-transcribe', key, on }
//   here -> worker   { type: 'kai-rec', key, event: 'progress', recorded, sent }
//                    { type: 'kai-rec', key, event: 'clip', at, wav }   (base64, 16 kHz mono WAV)
//                    { type: 'kai-rec', key, event: 'ended' }            (the tab or the sharing ended)
import { ResumableUpload, recordingMime } from '@src/store/drive-upload';
import { toWav } from './voice';

/** A clip for the transcription fallback. */
export const CLIP_MS = 15_000;

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
  #clips: { stop(): void } | null = null;
  #stopping: Promise<string> | null = null;

  /** `playBack`: tab capture silences the tab for the person, so the meeting is played back to them. */
  constructor(options: { tab: MediaStream; mic: MediaStream | null; uploadUrl: string; playBack: boolean }) {
    this.#tab = options.tab;
    this.#mic = options.mic;
    this.withMic = Boolean(options.mic);
    this.#audio = new AudioContext();
    this.#mix = this.#audio.createMediaStreamDestination();
    if (this.#tab.getAudioTracks().length) {
      const meeting = this.#audio.createMediaStreamSource(new MediaStream(this.#tab.getAudioTracks()));
      meeting.connect(this.#mix);
      if (options.playBack) meeting.connect(this.#audio.destination);
    }
    if (this.#mic) this.#audio.createMediaStreamSource(this.#mic).connect(this.#mix);
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
