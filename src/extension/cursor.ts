// Bash AI's cursor (Aaron 2026-11-26: "add a cursor to the browse agent so the staff/user can see what is happening").
// While a run works, a pointer labelled "Bash AI" is drawn where the agent points: it glides to each click, hover and
// scroll just before the layer sends it, and a press shows a ripple. It is drawn the way the page border is: the
// worker puts one small function into the top frame, which keeps an element on <html> that the layer does not see (no
// pointer events, hidden from accessibility, its content in a closed shadow root), so the page's own input and the
// layer's hit tests pass through it. It fades out for the model's screenshots, goes when the run stops working, and
// can be turned off in Settings.
//
// The cursor learns where the agent points from the layer's own input, without changing the layer: the controller's
// attacher is wrapped (watchPointerInput) so a mouse event on a tab's top-level session is shown to the cursor first.
// A move waits for the glide, at most MOVE_WAIT_MS; a press, a release and every other command go through untouched.
import type { Attacher, CdpPort } from '@src/browser-control';
import { settingsStorage } from '@src/store/settings';
import type { RunStatus } from '@src/store/types';

export interface CursorPoint {
  x: number;
  y: number;
}

export type CursorCommand =
  | { kind: 'move'; x: number; y: number; from: CursorPoint | null }
  | { kind: 'press' }
  | { kind: 'scroll'; down: boolean }
  | { kind: 'hidden' }
  | { kind: 'shown' }
  | { kind: 'off' };

/** The parts of an Input.dispatchMouseEvent the cursor reads. */
export interface MouseInput {
  type: string;
  x?: number;
  y?: number;
  deltaY?: number;
}

export interface CursorPorts {
  /** The conversation a tab belongs to, if any. */
  conversationOf(tabId: number): Promise<string | null>;
  /** A conversation's tabs. */
  tabsOf(conversationId: string): Promise<number[]>;
  /** Every tab that belongs to a conversation. */
  scopedTabs(): Promise<number[]>;
  /** The Settings switch. */
  enabled(): Promise<boolean>;
  /** Runs `setCursor(command)` in the tab's top frame; resolves when it has (a move: when the cursor arrived). */
  inject(tabId: number, command: CursorCommand): Promise<unknown>;
}

/** The longest an input waits for the cursor to get there; past it, the input goes ahead. */
export const MOVE_WAIT_MS = 450;
/** How long a screenshot waits for the cursor to hide; past it, the capture goes ahead. */
export const HIDE_WAIT_MS = 300;

/** Waits for `promise`, at most `ms`; never rejects. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise.catch(() => undefined), new Promise<void>(resolve => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

export class PageCursor {
  /** Conversations whose run is working now. */
  #running = new Set<string>();
  /** Where each tab's cursor was last sent, so the next page's cursor glides on from there. */
  #last = new Map<number, CursorPoint>();
  /** Tabs whose current document has a cursor drawn. */
  #drawn = new Set<number>();
  /** Screenshots in progress, per tab, and the hide they share. */
  #capturing = new Map<number, number>();
  #hiding = new Map<number, Promise<void>>();

  constructor(private readonly ports: CursorPorts) {}

  /** At worker start: no run is working yet, so no page keeps a cursor from before. */
  async start(): Promise<void> {
    for (const tabId of await this.ports.scopedTabs()) this.#off(tabId);
  }

  /** A run's status changed. Nothing is drawn until the agent points somewhere; a run that stops takes it away. */
  async status(conversationId: string, status: RunStatus): Promise<void> {
    if (status === 'running') {
      this.#running.add(conversationId);
      return;
    }
    this.#running.delete(conversationId);
    for (const tabId of await this.ports.tabsOf(conversationId)) this.#off(tabId);
  }

  /** Tabs left a conversation. */
  async tabsChanged(removed: number[]): Promise<void> {
    for (const tabId of removed) {
      this.#off(tabId);
      this.#last.delete(tabId);
    }
  }

  /** A new document committed in a tab's top frame: the old one's cursor went with it. */
  committed(tabId: number): void {
    this.#drawn.delete(tabId);
  }

  /** The Settings switch changed: turned off, every cursor goes at once; turned on, the next input draws it. */
  async settingChanged(): Promise<void> {
    if (await this.ports.enabled()) return;
    for (const tabId of await this.ports.scopedTabs()) this.#off(tabId);
  }

  /**
   * A mouse event the layer is about to send on a tab's top-level session. A move or a wheel waits until the cursor
   * got there (at most MOVE_WAIT_MS); a press shows its ripple without waiting. Never throws: drawing never stops an
   * action.
   */
  async input(tabId: number, input: MouseInput): Promise<void> {
    const kind = input.type;
    if (kind !== 'mouseMoved' && kind !== 'mousePressed' && kind !== 'mouseWheel') return;
    try {
      if (this.#capturing.get(tabId) || !(await this.#wanted(tabId))) return;
      if (kind === 'mousePressed') {
        if (this.#drawn.has(tabId)) this.#send(tabId, { kind: 'press' });
        return;
      }
      if (typeof input.x !== 'number' || typeof input.y !== 'number') return;
      const to = { x: input.x, y: input.y };
      const from = this.#last.get(tabId) ?? null;
      this.#last.set(tabId, to);
      this.#drawn.add(tabId);
      await within(this.ports.inject(tabId, { kind: 'move', x: to.x, y: to.y, from }), MOVE_WAIT_MS);
      if (kind === 'mouseWheel') this.#send(tabId, { kind: 'scroll', down: (input.deltaY ?? 0) >= 0 });
    } catch {
      // A tab that closed or a setting that could not be read: no cursor this time.
    }
  }

  /**
   * A screenshot of a tab: a drawn cursor hides first, waiting at most HIDE_WAIT_MS, and comes back after. A tab with
   * no cursor is captured at once. Screenshots of one tab that overlap share one hide.
   */
  async around<T>(tabId: number, capture: () => Promise<T>): Promise<T> {
    if (!this.#drawn.has(tabId)) return capture();
    const count = this.#capturing.get(tabId) ?? 0;
    this.#capturing.set(tabId, count + 1);
    if (!count) this.#hiding.set(tabId, within(this.ports.inject(tabId, { kind: 'hidden' }), HIDE_WAIT_MS));
    try {
      await this.#hiding.get(tabId);
      return await capture();
    } finally {
      const left = (this.#capturing.get(tabId) ?? 1) - 1;
      if (left > 0) this.#capturing.set(tabId, left);
      else {
        this.#capturing.delete(tabId);
        this.#hiding.delete(tabId);
        if (this.#drawn.has(tabId)) this.#send(tabId, { kind: 'shown' });
      }
    }
  }

  async #wanted(tabId: number): Promise<boolean> {
    const conversationId = await this.ports.conversationOf(tabId);
    return conversationId !== null && this.#running.has(conversationId) && (await this.ports.enabled());
  }

  #off(tabId: number): void {
    this.#drawn.delete(tabId);
    this.#send(tabId, { kind: 'off' });
  }

  /** Started and not waited for: a page with a dialog open holds an injection until the dialog closes. */
  #send(tabId: number, command: CursorCommand): void {
    void this.ports.inject(tabId, command).catch(() => undefined);
  }
}

/**
 * The attacher with each tab's mouse input shown to `before` first: an Input.dispatchMouseEvent on the top-level
 * session (the coordinates the layer clicks at) waits for `before`, and is then sent unchanged. Every other command,
 * event and part of the attachment is the attacher's own.
 */
export function watchPointerInput(
  attacher: Attacher,
  before: (tabId: number, input: MouseInput) => Promise<void> | void,
): Attacher {
  return {
    async attach(tabId) {
      const attachment = await attacher.attach(tabId);
      const inner = attachment.cdp;
      const cdp: CdpPort = {
        get tabId() {
          return inner.tabId;
        },
        send(sessionId, method, params, timeoutMs) {
          if (sessionId === undefined && method === 'Input.dispatchMouseEvent' && params) {
            let waiting: Promise<void> | void = undefined;
            try {
              waiting = before(attachment.tabId, params as MouseInput);
            } catch {
              // The cursor failed: the input goes ahead.
            }
            if (waiting) {
              return waiting.catch(() => undefined).then(() => inner.send(sessionId, method, params, timeoutMs));
            }
          }
          return inner.send(sessionId, method, params, timeoutMs);
        },
        on: (method, handler, only) => inner.on(method, handler, only),
      };
      // Everything but `cdp` is the attachment's own, read from it: the developer test panel reads properties of the
      // concrete connection (its Puppeteer page) that the interface does not name.
      return new Proxy(attachment, {
        get(target, prop) {
          if (prop === 'cdp') return cdp;
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
}

/**
 * Runs in the page, in the extension's isolated world, passed whole to chrome.scripting.executeScript: it must not use
 * anything from outside its own body. It keeps its element on the isolated world's globalThis, which page script
 * cannot see, so later calls find it (a closed shadow root cannot be reached from its host).
 */
export function setCursor(command: CursorCommand): Promise<void> | void {
  const KEY = '__bashAiCursor';
  type Cursor = {
    host: HTMLElement;
    layer: HTMLElement;
    pointer: HTMLElement;
    x: number;
    y: number;
    placed: boolean;
    timer: ReturnType<typeof setInterval>;
    onHide: () => void;
  };
  const g = globalThis as unknown as Record<string, Cursor | undefined>;
  const remove = () => {
    const c = g[KEY];
    if (!c) return;
    clearInterval(c.timer);
    removeEventListener('pagehide', c.onHide);
    c.host.remove();
    g[KEY] = undefined;
  };
  if (command.kind === 'off') return remove();
  let c = g[KEY];
  if (!c || !c.host.isConnected) {
    // Nothing to hide, show, press or scroll on a page that has no cursor yet.
    if (command.kind !== 'move') return;
    remove();
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('data-bash-ai-cursor', '');
    host.style.cssText =
      'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;contain:strict';
    const root = host.attachShadow({ mode: 'closed' });
    const blue = 'rgb(37 99 235)';
    root.innerHTML = `<style>
      .layer { position: absolute; inset: 0; transition: opacity 150ms ease; }
      .pointer { position: absolute; left: 0; top: 0; will-change: transform;
        transition-property: transform; transition-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1); }
      .arrow { position: absolute; left: -3px; top: -2px; display: block; transform-origin: 3px 2px;
        filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.35)); transition: transform 120ms ease; }
      .pressed .arrow { transform: scale(0.8); }
      .tag { position: absolute; left: 14px; top: 18px; padding: 2px 7px; border-radius: 6px; background: ${blue};
        color: #fff; font: 600 11px/16px system-ui, -apple-system, 'Segoe UI', sans-serif; letter-spacing: 0.01em;
        white-space: nowrap; box-shadow: 0 1px 3px rgb(0 0 0 / 0.3); }
      .ripple { position: absolute; left: -16px; top: -16px; width: 32px; height: 32px; border-radius: 50%;
        border: 2px solid ${blue}; background: rgb(37 99 235 / 0.15); animation: ripple 500ms ease-out forwards; }
      @keyframes ripple { from { transform: scale(0.25); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
      .scroll { position: absolute; left: -24px; top: -2px; width: 18px; height: 18px; color: ${blue};
        filter: drop-shadow(0 0 2px #fff); animation: scroll 600ms ease-out forwards; }
      @keyframes scroll { from { opacity: 1; translate: 0 0; } to { opacity: 0; translate: 0 var(--travel); } }
      @media (prefers-reduced-motion: reduce) {
        .pointer { transition: none !important; }
        .ripple, .scroll { animation-duration: 1ms; }
      }
    </style><div class="layer"><div class="pointer"><svg class="arrow" width="22" height="24" viewBox="0 0 22 24">
      <path d="M3 2 L3 19.5 L7.6 15.3 L10.6 21.8 L13.6 20.5 L10.7 14.1 L16.8 14.1 Z" fill="${blue}" stroke="#fff"
        stroke-width="1.6" stroke-linejoin="round"/></svg><span class="tag">Bash AI</span></div></div>`;
    document.documentElement.appendChild(host);
    // A page kept in the back-forward cache keeps its DOM, and its timers wait: it must not keep a cursor.
    const onHide = () => remove();
    addEventListener('pagehide', onHide);
    // When the extension is updated, reloaded, turned off or removed, its id is gone, and the cursor goes with it.
    const timer = setInterval(() => {
      if (!globalThis.chrome?.runtime?.id) remove();
    }, 2000);
    c = {
      host,
      layer: root.querySelector('.layer') as HTMLElement,
      pointer: root.querySelector('.pointer') as HTMLElement,
      x: 0,
      y: 0,
      placed: false,
      timer,
      onHide,
    };
    g[KEY] = c;
  }
  const cursor = c;
  const hiddenTab = document.visibilityState === 'hidden';

  if (command.kind === 'hidden' || command.kind === 'shown') {
    cursor.layer.style.transition = command.kind === 'hidden' ? 'none' : '';
    cursor.layer.style.opacity = command.kind === 'hidden' ? '0' : '1';
    // One frame so the hidden state is painted before the capture; a hidden tab paints nothing until then anyway.
    if (command.kind === 'shown' || hiddenTab) return;
    return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }

  if (command.kind === 'press' || command.kind === 'scroll') {
    if (hiddenTab) return;
    const mark = document.createElement('span');
    if (command.kind === 'press') {
      mark.className = 'ripple';
      cursor.pointer.classList.add('pressed');
      setTimeout(() => cursor.pointer.classList.remove('pressed'), 140);
    } else {
      mark.className = 'scroll';
      mark.style.setProperty('--travel', command.down ? '8px' : '-8px');
      mark.innerHTML = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round" stroke-linejoin="round"><path d="${command.down ? 'M4 6l4 4 4-4' : 'M4 10l4-4 4 4'}"/></svg>`;
    }
    cursor.pointer.appendChild(mark);
    setTimeout(() => mark.remove(), 700);
    return;
  }

  // A move: into the viewport, so the cursor stays on screen at its edges.
  const x = Math.min(Math.max(command.x, 0), Math.max(0, innerWidth - 2));
  const y = Math.min(Math.max(command.y, 0), Math.max(0, innerHeight - 2));
  const place = (px: number, py: number) => {
    cursor.pointer.style.transform = `translate(${px}px, ${py}px)`;
    cursor.x = px;
    cursor.y = py;
  };
  const still = hiddenTab || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!cursor.placed) {
    // A new page: the cursor comes in from where it last was on this tab, or appears where the agent points.
    cursor.placed = true;
    cursor.pointer.style.transitionDuration = '0ms';
    if (!command.from || still) {
      place(x, y);
      return;
    }
    place(
      Math.min(Math.max(command.from.x, 0), Math.max(0, innerWidth - 2)),
      Math.min(Math.max(command.from.y, 0), Math.max(0, innerHeight - 2)),
    );
    void cursor.pointer.getBoundingClientRect();
  }
  const distance = Math.hypot(x - cursor.x, y - cursor.y);
  if (distance < 1 || still) {
    cursor.pointer.style.transitionDuration = '0ms';
    place(x, y);
    return;
  }
  // Longer trips take a little longer, within what the input waits (MOVE_WAIT_MS).
  const ms = Math.round(Math.min(320, Math.max(150, distance * 0.4)));
  cursor.pointer.style.transitionDuration = `${ms}ms`;
  place(x, y);
  return new Promise<void>(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    cursor.pointer.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, ms + 40);
  });
}

/** Puts `setCursor(command)` into the top frame of a tab. */
export async function injectCursor(tabId: number, command: CursorCommand): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: setCursor,
    args: [command],
    injectImmediately: true,
  });
}

/** New documents in a tab's top frame, and the Settings switch. Registered at worker start. */
export function listenForCursor(cursor: PageCursor): void {
  chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) cursor.committed(details.tabId);
  });
  let enabled: boolean | undefined;
  settingsStorage.subscribe(() => {
    const next = settingsStorage.getSnapshot()?.agentCursor;
    if (next === undefined || next === enabled) return;
    const changed = enabled !== undefined;
    enabled = next;
    if (changed) void cursor.settingChanged().catch(() => undefined);
  });
  void settingsStorage.get().then(settings => (enabled ??= settings?.agentCursor));
}
