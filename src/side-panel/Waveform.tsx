// The voice agent's sound wave: rounded bars in the brand's gradient (cyan, blue, violet, as Command Center draws its
// accents), mirrored around a centre line. They follow the person's voice while it listens and its own voice while it
// speaks; a glow sweeps across while it thinks, and a soft pulse runs while it connects. Drawn on a canvas each frame;
// with reduced motion the bars still follow the sound but nothing drifts on its own.
import { useEffect, useRef } from 'react';

export type WaveMode = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

const BAR = 3;
const GAP = 3;

/** How tall the wave aims to be (0 to 1) in a mode, at a sound level. */
export function waveTarget(mode: WaveMode, level: number, t: number): number {
  switch (mode) {
    case 'listening':
      return Math.max(0.1, Math.min(1, level * 1.3));
    case 'speaking':
      return Math.max(0.14, Math.min(1, level * 1.5));
    case 'thinking':
      return 0.3;
    case 'connecting':
      return 0.12 + 0.08 * Math.sin(t * 3);
    default:
      // Idle: a soft, slow breath, so the wave looks ready rather than flat.
      return 0.13 + 0.05 * Math.sin(t * 1.4);
  }
}

/** One bar's height (0 to 1) at a time: a bell over the bars, times two slow waves, so the shape keeps moving. */
export function barHeight(i: number, n: number, amp: number, mode: WaveMode, t: number, still: boolean): number {
  const centre = mode === 'thinking' && !still ? ((Math.sin(t * 1.6) + 1) / 2) * (n - 1) : (n - 1) / 2;
  const spread = mode === 'thinking' ? n * 0.18 : n * 0.34;
  const bell = Math.exp(-(((i - centre) / spread) ** 2));
  const motion = still ? 1 : 0.62 + 0.38 * Math.sin(t * 7 + i * 0.55) * Math.cos(t * 4.3 - i * 0.27);
  return Math.max(0.04, amp * (0.25 + 0.75 * bell) * motion);
}

export function Waveform({ mode, level, compact }: { mode: WaveMode; level: () => number; compact?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ mode, level });
  latest.current = { mode, level };

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let amp = 0.05;
    let frame = 0;
    const start = performance.now();
    const draw = () => {
      const ratio = devicePixelRatio || 1;
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (el.width !== Math.round(width * ratio) || el.height !== Math.round(height * ratio)) {
        el.width = Math.round(width * ratio);
        el.height = Math.round(height * ratio);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const t = (performance.now() - start) / 1000;
      const { mode: m, level: read } = latest.current;
      const target = waveTarget(m, m === 'listening' || m === 'speaking' ? read() : 0, t);
      // Rises fast and falls slowly, like a level meter.
      amp += (target - amp) * (target > amp ? 0.35 : 0.1);
      const n = Math.max(8, Math.floor((width + GAP) / (BAR + GAP)));
      const offset = (width - (n * (BAR + GAP) - GAP)) / 2;
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, '#06B6D4');
      gradient.addColorStop(0.55, '#2563EB');
      gradient.addColorStop(1, '#7C3AED');
      ctx.fillStyle = gradient;
      ctx.globalAlpha = m === 'idle' ? 0.6 : m === 'connecting' ? 0.75 : 1;
      for (let i = 0; i < n; i++) {
        const h = Math.max(BAR, barHeight(i, n, amp, m, t, still) * (height - 4));
        const x = offset + i * (BAR + GAP);
        const y = (height - h) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, BAR, h, BAR / 2);
        ctx.fill();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvas} aria-hidden className={`block w-full ${compact ? 'h-9' : 'h-16'}`} />;
}
