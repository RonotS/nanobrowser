import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attacher, CdpPort, TabAttachment } from '@src/browser-control';
import { HIDE_WAIT_MS, MOVE_WAIT_MS, PageCursor, watchPointerInput } from '../cursor';
import type { CursorCommand } from '../cursor';

/** Two conversations: a with tabs 1 and 2, b with tab 3. */
function setup(options: { enabled?: boolean; inject?: (tabId: number, c: CursorCommand) => Promise<unknown> } = {}) {
  const sent: Array<[number, CursorCommand]> = [];
  const owner: Record<number, string> = { 1: 'a', 2: 'a', 3: 'b' };
  let enabled = options.enabled ?? true;
  const cursor = new PageCursor({
    conversationOf: async tabId => owner[tabId] ?? null,
    tabsOf: async c =>
      Object.keys(owner)
        .map(Number)
        .filter(t => owner[t] === c),
    scopedTabs: async () => Object.keys(owner).map(Number),
    enabled: async () => enabled,
    inject: async (tabId, command) => {
      sent.push([tabId, command]);
      if (options.inject) await options.inject(tabId, command);
    },
  });
  return { cursor, sent, setEnabled: (on: boolean) => (enabled = on) };
}

afterEach(() => vi.useRealTimers());

describe('PageCursor', () => {
  it('draws nothing until a working run points somewhere, then glides on from where it last was', async () => {
    const { cursor, sent } = setup();
    await cursor.status('a', 'running');
    expect(sent).toEqual([]);
    await cursor.input(1, { type: 'mouseMoved', x: 100, y: 200 });
    await cursor.input(1, { type: 'mousePressed', x: 100, y: 200 });
    await cursor.input(1, { type: 'mouseReleased', x: 100, y: 200 });
    await cursor.input(1, { type: 'mouseMoved', x: 300, y: 40 });
    expect(sent).toEqual([
      [1, { kind: 'move', x: 100, y: 200, from: null }],
      [1, { kind: 'press' }],
      [1, { kind: 'move', x: 300, y: 40, from: { x: 100, y: 200 } }],
    ]);
  });

  it('shows a scroll where the wheel turns, after the cursor got there', async () => {
    const { cursor, sent } = setup();
    await cursor.status('a', 'running');
    await cursor.input(2, { type: 'mouseWheel', x: 50, y: 60, deltaY: 400 });
    await cursor.input(2, { type: 'mouseWheel', x: 50, y: 60, deltaY: -400 });
    expect(sent.map(([, c]) => c.kind)).toEqual(['move', 'scroll', 'move', 'scroll']);
    expect(sent[1][1]).toEqual({ kind: 'scroll', down: true });
    expect(sent[3][1]).toEqual({ kind: 'scroll', down: false });
  });

  it('draws nothing for a run that is not working, for a tab of no conversation, or with the setting off', async () => {
    const { cursor, sent, setEnabled } = setup({ enabled: false });
    await cursor.status('a', 'running');
    await cursor.input(1, { type: 'mouseMoved', x: 1, y: 1 });
    setEnabled(true);
    await cursor.input(3, { type: 'mouseMoved', x: 1, y: 1 });
    await cursor.input(9, { type: 'mouseMoved', x: 1, y: 1 });
    expect(sent).toEqual([]);
  });

  it('takes the cursor away when the run stops working, when a tab leaves, and when the setting goes off', async () => {
    const { cursor, sent, setEnabled } = setup();
    await cursor.status('a', 'running');
    await cursor.input(1, { type: 'mouseMoved', x: 1, y: 1 });
    sent.length = 0;
    await cursor.status('a', 'awaiting_user');
    expect(sent).toEqual([
      [1, { kind: 'off' }],
      [2, { kind: 'off' }],
    ]);
    sent.length = 0;
    await cursor.tabsChanged([3]);
    expect(sent).toEqual([[3, { kind: 'off' }]]);
    sent.length = 0;
    setEnabled(false);
    await cursor.settingChanged();
    expect(sent.map(([t, c]) => `${t}:${c.kind}`)).toEqual(['1:off', '2:off', '3:off']);
  });

  it('never holds an input back longer than MOVE_WAIT_MS', async () => {
    vi.useFakeTimers();
    const { cursor } = setup({ inject: () => new Promise(() => {}) });
    await cursor.status('a', 'running');
    let done = false;
    void cursor.input(1, { type: 'mouseMoved', x: 5, y: 5 }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(MOVE_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('hides a drawn cursor for a screenshot and shows it after; a page with none is captured at once', async () => {
    const { cursor, sent } = setup();
    await cursor.status('a', 'running');
    const order: string[] = [];
    await cursor.around(1, async () => order.push('capture'));
    expect(sent).toEqual([]);
    await cursor.input(1, { type: 'mouseMoved', x: 5, y: 5 });
    sent.length = 0;
    await cursor.around(1, async () => {
      order.push(`capture after ${sent.map(([, c]) => c.kind).join(',')}`);
    });
    expect(order).toEqual(['capture', 'capture after hidden']);
    expect(sent.map(([, c]) => c.kind)).toEqual(['hidden', 'shown']);
  });

  it('a screenshot waits at most HIDE_WAIT_MS for the cursor to hide', async () => {
    vi.useFakeTimers();
    const { cursor } = setup({ inject: (_t, c) => (c.kind === 'hidden' ? new Promise(() => {}) : Promise.resolve()) });
    await cursor.status('a', 'running');
    await cursor.input(1, { type: 'mouseMoved', x: 5, y: 5 });
    let captured = false;
    void cursor.around(1, async () => (captured = true));
    await vi.advanceTimersByTimeAsync(HIDE_WAIT_MS - 1);
    expect(captured).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(captured).toBe(true);
  });

  it('forgets the drawn cursor when a new page commits: its screenshots need no hiding', async () => {
    const { cursor, sent } = setup();
    await cursor.status('a', 'running');
    await cursor.input(1, { type: 'mouseMoved', x: 5, y: 5 });
    cursor.committed(1);
    sent.length = 0;
    await cursor.around(1, async () => undefined);
    expect(sent).toEqual([]);
  });
});

describe('watchPointerInput', () => {
  class Connection {
    readonly tabId = 7;
    readonly detached = null;
    #secret = 'puppeteer page';
    readonly calls: Array<[string | undefined, string, object | undefined]> = [];
    readonly cdp: CdpPort = {
      tabId: 7,
      send: async (sessionId, method, params) => {
        this.calls.push([sessionId, method, params]);
        return { ok: method } as never;
      },
      on: () => () => undefined,
    };
    get diagnosticPage() {
      return this.#secret;
    }
    topology = {} as TabAttachment['topology'];
    page = {} as TabAttachment['page'];
    onDetach() {
      return () => undefined;
    }
    async close() {
      this.#secret = 'closed';
    }
  }

  it('holds a top-level mouse event until the cursor got there, then sends it unchanged', async () => {
    const connection = new Connection();
    const attacher: Attacher = { attach: async () => connection as unknown as TabAttachment };
    const seen: string[] = [];
    let arrive!: () => void;
    const watched = watchPointerInput(attacher, (tabId, input) => {
      seen.push(`${tabId}:${input.type}`);
      return new Promise<void>(resolve => (arrive = resolve));
    });
    const attachment = await watched.attach(7);
    const params = { type: 'mouseMoved', x: 3, y: 4 };
    const sending = attachment.cdp.send(undefined, 'Input.dispatchMouseEvent', params);
    await Promise.resolve();
    expect(seen).toEqual(['7:mouseMoved']);
    expect(connection.calls).toEqual([]);
    arrive();
    await expect(sending).resolves.toEqual({ ok: 'Input.dispatchMouseEvent' });
    expect(connection.calls).toEqual([[undefined, 'Input.dispatchMouseEvent', params]]);
  });

  it('leaves every other command, a frame session and the rest of the connection as they are', async () => {
    const connection = new Connection();
    const before = vi.fn();
    const attachment = await watchPointerInput(
      { attach: async () => connection as unknown as TabAttachment },
      before,
    ).attach(7);
    await attachment.cdp.send('frame-session', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await attachment.cdp.send(undefined, 'DOM.focus', { backendNodeId: 1 });
    expect(before).not.toHaveBeenCalled();
    expect(connection.calls.map(c => c[1])).toEqual(['Input.dispatchMouseEvent', 'DOM.focus']);
    expect((attachment as unknown as Connection).diagnosticPage).toBe('puppeteer page');
    expect(attachment.tabId).toBe(7);
    await attachment.close();
    expect((attachment as unknown as Connection).diagnosticPage).toBe('closed');
  });

  it('sends the input even when the cursor fails', async () => {
    const connection = new Connection();
    const attachment = await watchPointerInput({ attach: async () => connection as unknown as TabAttachment }, () =>
      Promise.reject(new Error('tab gone')),
    ).attach(7);
    await attachment.cdp.send(undefined, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
    expect(connection.calls).toHaveLength(1);
  });
});
