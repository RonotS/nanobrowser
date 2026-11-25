// Smooth streaming: an answer's text arrives in bursts (the model's chunks, and the worker's 50 ms batches), so the
// panel reveals what has arrived at an even pace instead of jumping chunk by chunk. The pace rises with the backlog, so
// the reveal never falls behind for long (about a third of a second at most), and it carries on from the streaming
// view into the finished answer, so the end does not jump either. Answers loaded from the history show at once, and so
// does everything with reduced motion.
import { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';

/** Characters a second: at least a steady typing pace, and fast enough to clear any backlog in ~0.3 s. */
export function revealRate(backlog: number): number {
  return Math.max(90, backlog * 3.5);
}

/** How many characters to show after `dtMs`, from `shown`, towards `total`. Fractions carry over between frames. */
export function nextShown(shown: number, total: number, dtMs: number): number {
  if (shown >= total) return total;
  const backlog = total - shown;
  return Math.min(total, shown + (revealRate(backlog) * Math.max(0, dtMs)) / 1000);
}

/**
 * How far each reply has been revealed in this panel, by reply id, so the finished answer carries on where the
 * streaming view stopped. Only replies that streamed here are in it.
 */
const revealed = new Map<string, number>();

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** The part of `text` to show now. `streaming`: the text is still arriving, so it starts from nothing. */
export function useSmoothText(id: string, text: string, streaming: boolean): string {
  const shown = useRef(revealed.get(id) ?? (streaming && !reducedMotion() ? 0 : text.length));
  const [, render] = useState(0);
  const target = useRef(text.length);
  target.current = text.length;

  useEffect(() => {
    if (reducedMotion()) {
      shown.current = target.current;
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const before = Math.floor(shown.current);
      shown.current = nextShown(shown.current, target.current, now - last);
      last = now;
      revealed.set(id, shown.current);
      if (Math.floor(shown.current) !== before) render(n => n + 1);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [id]);

  // A reply that never streamed here (loaded from the history) or that was rewritten shorter shows as it is.
  if (shown.current > text.length) shown.current = text.length;
  return text.slice(0, Math.floor(shown.current));
}

/** An answer's Markdown, revealed smoothly while it streams. */
export function SmoothMarkdown({ id, text, streaming }: { id: string; text: string; streaming: boolean }) {
  const visible = useSmoothText(id, text, streaming);
  return <Markdown text={visible} />;
}
