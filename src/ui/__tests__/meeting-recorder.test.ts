import { describe, expect, it } from 'vitest';
import { downsample, soundBetween } from '../meeting-recorder';

describe("the call's kept sound", () => {
  it('averages 48 kHz down to 16 kHz', () => {
    expect([...downsample(new Float32Array([0, 0.3, 0.6, 1, 1, 1]), 48_000)].map(v => +v.toFixed(2))).toEqual([0.3, 1]);
  });

  it('cuts the samples between two times out of the kept pieces', () => {
    // Two pieces of 1 s each (16,000 samples), ending at 1000 ms and 2000 ms.
    const pieces = [
      { end: 1000, samples: new Float32Array(16_000).fill(0.1) },
      { end: 2000, samples: new Float32Array(16_000).fill(0.2) },
    ];
    const cut = soundBetween(pieces, 500, 1500)!;
    expect(cut.length).toBe(16_000);
    expect(cut[0]).toBeCloseTo(0.1);
    expect(cut[15_999]).toBeCloseTo(0.2);
    expect(soundBetween(pieces, 1990, 2000)).toBeNull();
  });
});
