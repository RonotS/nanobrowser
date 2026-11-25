import { describe, expect, it } from 'vitest';
import { barHeight, waveTarget } from '../Waveform';

describe('the voice wave', () => {
  it('follows the sound while listening and speaking, and stays low otherwise', () => {
    expect(waveTarget('listening', 0.5, 0)).toBeCloseTo(0.65);
    expect(waveTarget('listening', 0, 0)).toBe(0.1);
    expect(waveTarget('speaking', 1, 0)).toBe(1);
    expect(waveTarget('idle', 1, 0)).toBe(0.06);
    expect(waveTarget('thinking', 0, 0)).toBe(0.3);
  });

  it('is tallest in the middle, and the thinking glow travels across', () => {
    const n = 41;
    const still = (i: number) => barHeight(i, n, 1, 'speaking', 0, true);
    expect(still(20)).toBeGreaterThan(still(0));
    const peak = (t: number) => {
      const heights = Array.from({ length: n }, (_, i) => barHeight(i, n, 1, 'thinking', t, false));
      return heights.indexOf(Math.max(...heights));
    };
    expect(peak(0)).not.toBe(peak(1));
  });

  it('never draws a bar of nothing', () => {
    expect(barHeight(0, 40, 0, 'idle', 0, true)).toBeGreaterThan(0);
  });
});

describe('smooth streaming', () => {
  it('reveals at a steady pace, faster with a backlog, and never past what arrived', async () => {
    const { nextShown, revealRate } = await import('../SmoothText');
    expect(revealRate(10)).toBe(90);
    expect(revealRate(1000)).toBe(3500);
    // 16 ms at 90 characters a second is about 1.4 characters.
    expect(nextShown(0, 10, 16)).toBeCloseTo(1.44);
    // A big backlog clears within about a third of a second.
    let shown = 0;
    for (let i = 0; i < 20; i++) shown = nextShown(shown, 1000, 16);
    expect(shown).toBeGreaterThan(600);
    expect(nextShown(990, 1000, 1000)).toBe(1000);
    expect(nextShown(1000, 1000, 16)).toBe(1000);
  });
});
