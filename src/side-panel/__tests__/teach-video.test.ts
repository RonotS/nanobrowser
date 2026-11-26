import { describe, expect, it } from 'vitest';
import {
  CHANGE_THRESHOLD,
  fitBudget,
  MAX_SAMPLES,
  MAX_STILLS,
  MAX_TEACH_SECONDS,
  durationProblem,
  frameDifference,
  isSilent,
  isVideoFile,
  keepChanges,
  sampleTimes,
  spreadEvenly,
  wavChunks,
} from '../teach-video';

const flat = (value: number, n = 16) => new Array(n).fill(value);

describe('teach from a video: which frames become stills', () => {
  it('measures how different two frames are, from 0 to 1', () => {
    expect(frameDifference(flat(10), flat(10))).toBe(0);
    expect(frameDifference(flat(0), flat(255))).toBe(1);
    expect(frameDifference(flat(0), flat(51))).toBeCloseTo(0.2);
  });

  it('keeps the first frame and each one that changed enough since the last still', () => {
    const small = Math.ceil(CHANGE_THRESHOLD * 255 * 0.5);
    const big = Math.ceil(CHANGE_THRESHOLD * 255 * 2);
    // A slow drift is compared with the last still kept, so it adds up to a new still.
    const frames = [flat(0), flat(small), flat(small * 2 + 1), flat(small * 2 + 1), flat(small * 2 + 1 + big)];
    expect(keepChanges(frames)).toEqual([0, 2, 4]);
    expect(keepChanges([])).toEqual([]);
  });

  it('thins out too many stills evenly, keeping the first and the last', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const picked = spreadEvenly(items, MAX_STILLS);
    expect(picked).toHaveLength(MAX_STILLS);
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(99);
    expect(new Set(picked).size).toBe(MAX_STILLS);
    expect(spreadEvenly([1, 2, 3], 40)).toEqual([1, 2, 3]);
  });

  it('looks every second, less often for a long video, and at the end', () => {
    expect(sampleTimes(3.5)).toEqual([0, 1, 2, 3, 3.4]);
    const long = sampleTimes(1200);
    expect(long.length).toBeLessThanOrEqual(MAX_SAMPLES + 1);
    expect(long[1]).toBe(2);
    expect(long.at(-1)).toBeCloseTo(1199.9);
  });
});

describe('teach from a video: limits', () => {
  it('reads up to about 20 minutes', () => {
    expect(durationProblem(60)).toBeNull();
    expect(durationProblem(20 * 60)).toBeNull();
    expect(durationProblem(MAX_TEACH_SECONDS + 1)).toBe('too-long');
    expect(durationProblem(Number.NaN)).toBe('unreadable');
    expect(durationProblem(Infinity)).toBe('unreadable');
    expect(durationProblem(0)).toBe('unreadable');
  });

  it('knows a video by its type or, without one, its name', () => {
    expect(isVideoFile('a.bin', 'video/mp4')).toBe(true);
    expect(isVideoFile('Screen Recording.MOV', '')).toBe(true);
    expect(isVideoFile('notes.pdf', 'application/pdf')).toBe(false);
  });
});

describe('teach from a video: the narration', () => {
  it('cuts the sound into WAV pieces under the limit, each with its own header', () => {
    const samples = new Float32Array(10_000).fill(0.5);
    const chunks = wavChunks(samples, 16_000, 44 + 2 * 4_000);
    expect(chunks.map(c => c.length)).toEqual([44 + 8_000, 44 + 8_000, 44 + 4_000]);
    for (const chunk of chunks) {
      const view = new DataView(chunk.buffer, chunk.byteOffset);
      expect(String.fromCharCode(...chunk.subarray(0, 4))).toBe('RIFF');
      expect(view.getUint32(24, true)).toBe(16_000);
      expect(view.getUint32(40, true)).toBe(chunk.length - 44);
    }
  });

  it('keeps a 20-minute recording at 16 kHz within Command Center’s 9.5 MB a request', () => {
    const chunks = wavChunks(new Float32Array(16_000 * 60 * 20), 16_000);
    expect(chunks.length).toBe(5);
    expect(Math.max(...chunks.map(c => c.length))).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('treats a silent track as no narration', () => {
    expect(isSilent(new Float32Array(16_000))).toBe(true);
    const speech = new Float32Array(16_000);
    speech[3200] = 0.3;
    expect(isSilent(speech)).toBe(false);
  });
});

describe('the stills fit one request', () => {
  it('thins them evenly until they weigh at most the budget, keeping the first and the last', () => {
    const stills = Array.from({ length: 40 }, (_, i) => ({ atSec: i, jpeg: new Uint8Array(250_000) }));
    const kept = fitBudget(stills, 5_500_000);
    expect(kept.reduce((n, s) => n + s.jpeg.length, 0)).toBeLessThanOrEqual(5_500_000);
    expect(kept[0].atSec).toBe(0);
    expect(kept.at(-1)?.atSec).toBe(39);
    const light = stills.slice(0, 10);
    expect(fitBudget(light, 5_500_000)).toHaveLength(10);
  });
});
