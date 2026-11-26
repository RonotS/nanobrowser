// Teach from a video, the reading part: a still of the screen each time it changes, and the narration as 16 kHz mono
// WAV in pieces small enough for Command Center's transcription route. All in the panel: the video never leaves the
// browser, only the stills (to Claude) and the sound (to the transcription model) do, through Command Center.
import { downmix, encodeWav, SAMPLE_RATE } from '@src/ui/voice';

/** The longest recording read: about 20 minutes, with a little slack for a recording that runs just over. */
export const MAX_TEACH_SECONDS = 20 * 60 + 30;
/** The most stills sent to Claude. */
export const MAX_STILLS = 40;
/** The most frames looked at, however long the video: a long one is sampled less often than once a second. */
export const MAX_SAMPLES = 600;
/** How different (0 to 1) a frame must be from the last still kept to become a still of its own. */
export const CHANGE_THRESHOLD = 0.04;
/** A WAV piece's limit: Command Center takes 9.5 MB a request. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** A still's widest side. */
export const STILL_WIDTH = 1024;
/**
 * The most the stills may weigh together. They travel as base64 (a third larger) in one request, and Command Center
 * refuses a request over 9.5 MB before it logs anything: 40 stills of a screen at 1,280 px went past that (Nov 26).
 */
export const STILLS_BUDGET_BYTES = 5_500_000;
/** The size of the small grey copy frames are compared on. */
const SIGNATURE_W = 48;
const SIGNATURE_H = 27;

export type TeachProblem = 'not-video' | 'too-long' | 'unreadable';

/** Whether a picked file is a video: by its type, or by its name when the type is missing (a .mov often has none). */
export function isVideoFile(name: string, type: string): boolean {
  return type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(name);
}

/** Why a video of this length cannot be read, or null when it can. */
export function durationProblem(seconds: number): TeachProblem | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unreadable';
  return seconds > MAX_TEACH_SECONDS ? 'too-long' : null;
}

/** The times to look at: every second, or evenly spread when the video is longer than MAX_SAMPLES seconds. */
export function sampleTimes(durationSec: number, maxSamples = MAX_SAMPLES): number[] {
  const step = Math.max(1, durationSec / maxSamples);
  const times: number[] = [];
  for (let t = 0; t < durationSec; t += step) times.push(Math.round(t * 100) / 100);
  // The end of the video: often the finished state of the task.
  const last = Math.max(0, durationSec - 0.1);
  if (!times.length || last - times[times.length - 1] > 0.2) times.push(Math.round(last * 100) / 100);
  return times;
}

/** How different two grey copies are: the mean absolute difference of their pixels, 0 (same) to 1. */
export function frameDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n / 255;
}

/**
 * Which frames become stills: the first, then each that differs enough from the last one kept. Indices into
 * `signatures`, in order.
 */
export function keepChanges(signatures: ArrayLike<number>[], threshold = CHANGE_THRESHOLD): number[] {
  const kept: number[] = [];
  for (let i = 0; i < signatures.length; i++) {
    if (!kept.length || frameDifference(signatures[kept[kept.length - 1]], signatures[i]) > threshold) kept.push(i);
  }
  return kept;
}

/** At most `cap` of `items`, spread evenly from the first to the last. */
export function spreadEvenly<T>(items: T[], cap = MAX_STILLS): T[] {
  if (items.length <= cap) return items;
  if (cap <= 1) return items.slice(0, cap);
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(items[Math.round((i * (items.length - 1)) / (cap - 1))]);
  return out;
}

/** Mono samples as WAV pieces of at most `maxBytes` each (the 44-byte header included). */
export function wavChunks(samples: Float32Array, sampleRate: number, maxBytes = MAX_CHUNK_BYTES): Uint8Array[] {
  const perChunk = Math.max(1, Math.floor((maxBytes - 44) / 2));
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < samples.length; start += perChunk) {
    chunks.push(encodeWav(samples.subarray(start, start + perChunk), sampleRate));
  }
  return chunks;
}

/** Whether a sound track is silence (or close to it): then there is nothing to transcribe. */
export function isSilent(samples: Float32Array, floor = 0.01): boolean {
  for (let i = 0; i < samples.length; i += 160) if (Math.abs(samples[i]) > floor) return false;
  return true;
}

export interface Still {
  atSec: number;
  jpeg: Uint8Array;
}

/** Waits for one event on the video, failing on its error, on a timeout or when stopped. */
function waitFor(target: EventTarget, event: string, signal?: AbortSignal, ms = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (error?: Error) => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    const done = () => settle();
    const failed = () => settle(new Error('unreadable'));
    const aborted = () => settle(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(failed, ms);
    if (signal?.aborted) return aborted();
    target.addEventListener(event, done);
    target.addEventListener('error', failed);
    signal?.addEventListener('abort', aborted);
  });
}

/** Opens a video file; its duration is read even for a recording that does not state one (MediaRecorder's WebM). */
export async function openVideo(file: File, signal?: AbortSignal): Promise<{ video: HTMLVideoElement; url: string }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = url;
  try {
    await waitFor(video, 'loadedmetadata', signal);
    if (!Number.isFinite(video.duration)) {
      // A WebM from MediaRecorder: seeking far past the end makes Chrome work the duration out.
      video.currentTime = 1e7;
      await waitFor(video, 'seeked', signal);
      video.currentTime = 0;
      await waitFor(video, 'seeked', signal);
    }
    return { video, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function seek(video: HTMLVideoElement, atSec: number, signal?: AbortSignal): Promise<void> {
  if (Math.abs(video.currentTime - atSec) < 0.001) return;
  const seeked = waitFor(video, 'seeked', signal);
  video.currentTime = atSec;
  await seeked;
}

/**
 * The stills: a small grey copy of each sampled frame is compared with the last still kept, and a frame that differs
 * enough is kept as a JPEG at most STILL_WIDTH wide. More than MAX_STILLS are thinned out evenly. `onProgress` gets the
 * share looked at (0 to 1) and the stills so far.
 */
export async function readStills(
  video: HTMLVideoElement,
  onProgress: (share: number, stills: number) => void,
  signal?: AbortSignal,
): Promise<Still[]> {
  const small = document.createElement('canvas');
  small.width = SIGNATURE_W;
  small.height = SIGNATURE_H;
  const smallCtx = small.getContext('2d', { willReadFrequently: true });
  const width = Math.min(STILL_WIDTH, video.videoWidth || STILL_WIDTH);
  const height = Math.max(1, Math.round((width * (video.videoHeight || 720)) / (video.videoWidth || 1280)));
  const big = document.createElement('canvas');
  big.width = width;
  big.height = height;
  const bigCtx = big.getContext('2d');
  if (!smallCtx || !bigCtx) throw new Error('unreadable');

  const times = sampleTimes(video.duration);
  const stills: Still[] = [];
  let last: Uint8ClampedArray | null = null;
  for (const [i, atSec] of times.entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await seek(video, atSec, signal);
    smallCtx.drawImage(video, 0, 0, SIGNATURE_W, SIGNATURE_H);
    const rgba = smallCtx.getImageData(0, 0, SIGNATURE_W, SIGNATURE_H).data;
    const grey = new Uint8ClampedArray(SIGNATURE_W * SIGNATURE_H);
    for (let p = 0; p < grey.length; p++) grey[p] = (rgba[p * 4] * 3 + rgba[p * 4 + 1] * 6 + rgba[p * 4 + 2]) / 10;
    if (!last || frameDifference(last, grey) > CHANGE_THRESHOLD) {
      last = grey;
      bigCtx.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob | null>(resolve => big.toBlob(resolve, 'image/jpeg', 0.7));
      if (blob) stills.push({ atSec, jpeg: new Uint8Array(await blob.arrayBuffer()) });
    }
    onProgress((i + 1) / times.length, stills.length);
  }
  return fitBudget(spreadEvenly(stills, MAX_STILLS));
}

/** Thins the stills evenly (first and last kept) until together they weigh at most `maxBytes`. */
export function fitBudget<T extends { jpeg: Uint8Array }>(stills: T[], maxBytes = STILLS_BUDGET_BYTES): T[] {
  const weight = (list: T[]) => list.reduce((sum, s) => sum + s.jpeg.length, 0);
  let kept = stills;
  while (kept.length > 2 && weight(kept) > maxBytes)
    kept = spreadEvenly(kept, Math.max(2, Math.floor(kept.length * 0.8)));
  return kept;
}

/** The narration as WAV pieces, or [] when the video has no sound track or only silence. */
export async function readNarration(file: File): Promise<Uint8Array[]> {
  try {
    // Decoding at 16 kHz resamples it; Chrome decodes the sound of MP4, WebM and MOV files.
    const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    const mono = downmix(channels);
    return isSilent(mono) ? [] : wavChunks(mono, SAMPLE_RATE);
  } catch {
    // No sound track (or one Chrome cannot decode): the steps come from the stills alone.
    return [];
  }
}
