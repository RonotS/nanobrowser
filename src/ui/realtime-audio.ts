// Audio for the voice agent: the microphone as 16-bit PCM chunks for the voice model, and the voice model's 16-bit PCM
// answer played back without gaps. Both run at the sample rate the voice models take (24 kHz); Chrome resamples the
// microphone to the AudioContext's rate. Nothing is recorded or kept: chunks go straight to the voice model.

/** The rate both OpenAI's and xAI's realtime voices use for PCM in and out. */
export const VOICE_SAMPLE_RATE = 24_000;

/** Float samples in [-1, 1] as little-endian 16-bit PCM, base64-encoded, as the realtime APIs take audio. */
export function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Base64 16-bit PCM as float samples. */
export function base64ToFloat(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const out = new Float32Array(Math.floor(binary.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** How loud a stretch of audio is, 0 to 1: its RMS, scaled so speech reaches the top. */
export function loudness(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

function meter(context: AudioContext): { node: AnalyserNode; level: () => number } {
  const node = context.createAnalyser();
  node.fftSize = 1024;
  const buffer = new Float32Array(node.fftSize);
  return {
    node,
    level: () => {
      node.getFloatTimeDomainData(buffer);
      return loudness(buffer);
    },
  };
}

/** Why the microphone could not start: not allowed, missing, or another failure. */
export type MicError = 'not-allowed' | 'no-microphone' | 'error';

/** The microphone, sending ~100 ms chunks of base64 PCM until stop(). */
export class MicStream {
  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
    /** How loud the person is right now, 0 to 1: for the wave in the panel. */
    readonly level: () => number,
  ) {}

  static async start(onChunk: (base64: string) => void): Promise<MicStream | MicError> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'not-allowed';
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-microphone';
      return 'error';
    }
    try {
      const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      await context.audioWorklet.addModule(chrome.runtime.getURL('/voice-capture-worklet.js'));
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'voice-capture');
      node.port.onmessage = event => onChunk(pcm16Base64(event.data as Float32Array));
      source.connect(node);
      const input = meter(context);
      source.connect(input.node);
      return new MicStream(stream, context, node, input.level);
    } catch {
      stream.getTracks().forEach(track => track.stop());
      return 'error';
    }
  }

  stop(): void {
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.stream.getTracks().forEach(track => track.stop());
    void this.context.close().catch(() => undefined);
  }
}

/**
 * Plays the voice model's answer: each chunk is scheduled right after the one before, so speech has no gaps. clear()
 * stops at once, for when the person starts talking over it.
 */
export class PcmPlayer {
  #context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
  #next = 0;
  #playing = new Set<AudioBufferSourceNode>();
  /** Every chunk plays through this meter on its way out, so the wave follows the voice. */
  #output = meter(this.#context);

  constructor() {
    this.#output.node.connect(this.#context.destination);
  }

  /** How loud the answer is right now, 0 to 1. */
  level(): number {
    return this.#playing.size ? this.#output.level() : 0;
  }

  /** Whether any of the answer is still playing. */
  get speaking(): boolean {
    return this.#playing.size > 0;
  }

  play(base64: string): void {
    const samples = base64ToFloat(base64);
    if (!samples.length) return;
    const buffer = this.#context.createBuffer(1, samples.length, VOICE_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#output.node);
    const at = Math.max(this.#context.currentTime + 0.02, this.#next);
    source.start(at);
    this.#next = at + buffer.duration;
    this.#playing.add(source);
    source.onended = () => this.#playing.delete(source);
  }

  clear(): void {
    for (const source of this.#playing) source.stop();
    this.#playing.clear();
    this.#next = 0;
  }

  close(): void {
    this.clear();
    void this.#context.close().catch(() => undefined);
  }
}
