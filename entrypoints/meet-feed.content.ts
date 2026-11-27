// The notetaker's tap on Google Meet's caption feed, in Meet's own JavaScript world (src/store/meet-feed.ts says what
// the feed is). It runs at document_start on every Meet page, before Meet opens its WebRTC connection, and wraps
// RTCPeerConnection's data channels to note the two that carry captions and names (`captions_v2`, `collections`).
// Nothing is read or passed on until the notes script in the extension's world says start (Take notes), and nothing
// Meet sends or receives is changed. The two worlds talk with DOM events on `document`:
//   extension -> page  kai-meet-feed:ext   { type: 'hello' | 'start' | 'stop' } | { type: 'send', label, buf }
//   page -> extension  kai-meet-feed:page  { type: 'hooked' } | { type: 'open' | 'close', label }
//                                          | { type: 'msg', label, dir: 'in' | 'out', buf }
// Learned from CallScribe's src/page/meet-channels.js (MIT, read Nov 27 2026).
import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  matches: ['https://meet.google.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  noScriptStartedPostMessage: true,
  main() {
    const w = window as Window & { __kaiMeetFeed?: boolean };
    if (w.__kaiMeetFeed) return;
    Object.defineProperty(w, '__kaiMeetFeed', { value: true });

    const LABELS = new Set(['captions_v2', 'collections']);
    const PC = window.RTCPeerConnection;
    const DC = window.RTCDataChannel;
    if (!PC?.prototype.createDataChannel || !DC) return;
    const nativeSend = DC.prototype.send;
    const channels = new Map<string, RTCDataChannel>();
    const tapped = new WeakSet<RTCDataChannel>();
    const watched = new WeakSet<RTCPeerConnection>();
    let active = false;

    const toExtension = (detail: Record<string, unknown>) =>
      document.dispatchEvent(new CustomEvent('kai-meet-feed:page', { detail }));

    const forward = (label: string, dir: 'in' | 'out', data: unknown) => {
      if (!active) return;
      const emit = (buf: ArrayBuffer) => toExtension({ type: 'msg', label, dir, buf });
      if (data instanceof ArrayBuffer) emit(data.slice(0));
      else if (ArrayBuffer.isView(data))
        emit(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer);
      else if (data instanceof Blob) void data.arrayBuffer().then(emit, () => undefined);
    };

    const tap = (ch: RTCDataChannel) => {
      const label = ch.label;
      if (!LABELS.has(label) || tapped.has(ch)) return;
      tapped.add(ch);
      channels.set(label, ch);
      ch.addEventListener('message', e => {
        if (e.isTrusted) forward(label, 'in', e.data);
      });
      ch.addEventListener('open', () => {
        channels.set(label, ch);
        toExtension({ type: 'open', label });
      });
      ch.addEventListener('close', () => {
        if (channels.get(label) === ch) channels.delete(label);
        toExtension({ type: 'close', label });
      });
      // Meet's own requests (its CC button) pass through here unchanged; the notes script watches them.
      ch.send = function (this: RTCDataChannel, data: never) {
        try {
          forward(label, 'out', data);
        } catch {
          // Never stand in the way of Meet's own message.
        }
        return nativeSend.call(this, data);
      };
      if (ch.readyState === 'open') toExtension({ type: 'open', label });
    };

    const create = PC.prototype.createDataChannel;
    PC.prototype.createDataChannel = function (this: RTCPeerConnection, ...args: Parameters<typeof create>) {
      const ch = create.apply(this, args);
      try {
        // `collections` is opened by the server: listen on every connection Meet makes.
        if (!watched.has(this)) {
          watched.add(this);
          this.addEventListener('datachannel', e => {
            if (e.isTrusted) tap(e.channel);
          });
        }
        tap(ch);
      } catch {
        // Meet's call goes on whatever happens here.
      }
      return ch;
    };

    document.addEventListener('kai-meet-feed:ext', event => {
      const m = (event as CustomEvent).detail as { type?: string; label?: string; buf?: ArrayBuffer } | null;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'hello') {
        toExtension({ type: 'hooked' });
        for (const [label, ch] of channels) if (ch.readyState === 'open') toExtension({ type: 'open', label });
      } else if (m.type === 'start') active = true;
      else if (m.type === 'stop') active = false;
      else if (m.type === 'send' && m.label && LABELS.has(m.label) && m.buf instanceof ArrayBuffer) {
        const ch = channels.get(m.label);
        if (ch?.readyState === 'open' && m.buf.byteLength <= 64 * 1024) nativeSend.call(ch, new Uint8Array(m.buf));
      }
    });
  },
});
