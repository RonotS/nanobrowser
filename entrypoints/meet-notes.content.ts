// The notetaker in the Meet tab, in the extension's world (Aaron 2026-11-27: notes without Meet's captions box). It
// sleeps until the worker says start (Take notes), then taps Meet's caption feed through the hook in Meet's own world
// (meet-feed.content.ts; the feed itself: src/store/meet-feed.ts) and reports each changed utterance, named, to the
// worker (src/extension/meet-notes.ts). It also posts the consent notice in Meet's chat when asked.
import { defineContentScript } from 'wxt/utils/define-content-script';
import { FeedSession } from '@src/store/meet-feed';
import { inMeetCall, postMeetChat, tileNames } from '@src/ui/meet-page';

/** Worker -> tab. */
type NotesCommand =
  | { type: 'kai-notes-tab'; op: 'start'; key: string; lang: string }
  | { type: 'kai-notes-tab'; op: 'stop'; key: string }
  | { type: 'kai-notes-tab'; op: 'ping' }
  | { type: 'kai-notes-tab'; op: 'post-chat'; text: string };

export default defineContentScript({
  matches: ['https://meet.google.com/*'],
  runAt: 'document_start',
  noScriptStartedPostMessage: true,
  main() {
    let session: FeedSession | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let askAgain: ReturnType<typeof setTimeout> | null = null;

    const toPage = (detail: Record<string, unknown>) =>
      document.dispatchEvent(new CustomEvent('kai-meet-feed:ext', { detail }));

    const report = () => {
      pending = null;
      if (!session) return;
      try {
        void chrome.runtime.sendMessage(session.flush()).catch(() => undefined);
      } catch {
        // The extension was reloaded: this copy of the script is orphaned.
        stop();
      }
    };
    const reportSoon = () => {
      pending ??= setTimeout(report, 300);
    };

    document.addEventListener('kai-meet-feed:page', event => {
      const m = (event as CustomEvent).detail as {
        type?: string;
        label?: string;
        dir?: 'in' | 'out';
        buf?: ArrayBuffer;
      };
      if (!session || !m || typeof m !== 'object') return;
      if (m.type === 'hooked') session.hooked();
      else if (m.type === 'open' && m.label) session.opened(m.label);
      else if (m.type === 'close' && m.label) session.closed(m.label);
      else if (m.type === 'msg' && m.label && m.dir && m.buf instanceof ArrayBuffer) {
        // Meet's CC button changed captions: ask for ours again once it has its answer.
        if (session.message(m.label, m.dir, new Uint8Array(m.buf))) {
          if (askAgain) clearTimeout(askAgain);
          askAgain = setTimeout(() => session?.ask(), 1500);
        }
      }
      reportSoon();
    });

    function start(key: string, lang: string) {
      stop();
      session = new FeedSession(key, lang, {
        send: (label, bytes) => toPage({ type: 'send', label, buf: bytes.slice().buffer }),
        tileNames,
        inCall: inMeetCall,
        now: () => Date.now(),
      });
      toPage({ type: 'start' });
      toPage({ type: 'hello' });
      heartbeat = setInterval(report, 3000);
      report();
    }

    function stop() {
      if (heartbeat) clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
      if (askAgain) clearTimeout(askAgain);
      heartbeat = pending = askAgain = null;
      if (session) toPage({ type: 'stop' });
      session = null;
    }

    chrome.runtime.onMessage.addListener((message: NotesCommand, _sender, reply) => {
      if (message?.type !== 'kai-notes-tab') return;
      if (message.op === 'ping') reply({ ok: true });
      else if (message.op === 'start') {
        start(message.key, message.lang);
        reply({ ok: true });
      } else if (message.op === 'stop') {
        stop();
        reply({ ok: true });
      } else if (message.op === 'post-chat') {
        void postMeetChat(message.text).then(result => reply({ result }));
        return true;
      }
      return undefined;
    });
  },
});
