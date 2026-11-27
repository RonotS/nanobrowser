// Bash AI's notetaker in the side panel (Aaron 2026-11-27): notes from the person's own Google Meet tab, no bot in the
// call. Meet's captions give a named transcript (meet-notes-page.ts reads them in the tab); it streams here, a question
// about it goes to the chat, the meeting is told in its chat, and Stop and save writes an AI summary and saves it all to
// Command Center (store/meeting-notes.ts). Notes are taken while this panel is open.
import { useEffect, useRef, useState } from 'react';
import { generateText } from 'ai';
import { saveChatToCommandCenter } from '@src/store/command-center';
import {
  CONSENT_NOTICE,
  SUMMARY_SYSTEM,
  applyRows,
  meetTitle,
  notesClock,
  notesForCommandCenter,
  notesQuote,
  notesStorage,
  summaryPrompt,
} from '@src/store/meeting-notes';
import type { NotesLine, NotesSession } from '@src/store/meeting-notes';
import type { ChatModel } from '@src/llm/providers';
import { t } from '@src/ui/i18n';
import { SpinnerIcon } from '@src/ui/icons';
import { postMeetChat, startMeetNotes, stopMeetNotes } from './meet-notes-page';
import type { CaptionScan } from './meet-notes-page';
import { useSmoothText } from './SmoothText';
import type { SideAsk } from './side-view';

const ANIMATED_LINES = 6;
/** Out of the call this long (after being in it): the notes stop and save themselves. */
const LEFT_CALL_MS = 20_000;

/** Starts notes in a Meet tab: the caption reader, then the consent notice in the Meet chat. */
export async function startNotes(tab: { id: number; url: string; title: string }): Promise<void> {
  const key = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const session: NotesSession = {
    key,
    meetUrl: tab.url,
    title: meetTitle(tab.title, tab.url),
    tabId: tab.id,
    startedAt: new Date().toISOString(),
    lines: [],
    notice: 'posting',
  };
  await notesStorage.set(session);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: startMeetNotes, args: [key] });
  const [posted] = await chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: postMeetChat, args: [CONSENT_NOTICE] })
    .catch(() => [{ result: 'failed' }]);
  await notesStorage.set(current =>
    current?.key === key ? { ...current, notice: posted?.result === 'sent' ? 'posted' : 'failed' } : current,
  );
}

export function NotesView({ model, onAsk }: { model: ChatModel | null; onAsk: (ask: SideAsk) => void }) {
  const [session, setSession] = useState<NotesSession | null>(null);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState<'saving' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fresh = useRef(new Set<string>());
  const lines = useRef<NotesLine[]>([]);
  const dirty = useRef(false);
  const lastInCall = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [, render] = useState(0);

  useEffect(() => {
    void notesStorage.get().then(s => {
      setSession(s);
      lines.current = s?.lines ?? [];
      render(n => n + 1);
    });
    return notesStorage.subscribe(
      () =>
        void notesStorage.get().then(s => {
          setSession(s);
          if (s && !dirty.current) lines.current = s.lines;
        }),
    );
  }, []);

  const active = Boolean(session && !session.savedAt);

  // The page's caption reader may have stopped (the tab reloaded): start it again under the same key.
  useEffect(() => {
    if (!session || session.savedAt) return;
    void chrome.scripting
      .executeScript({ target: { tabId: session.tabId }, func: startMeetNotes, args: [session.key] })
      .catch(() => setError(t('notes.tabGone')));
  }, [session?.key, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Caption scans from the Meet tab.
  useEffect(() => {
    if (!session || session.savedAt) return;
    const key = session.key;
    const onMessage = (message: CaptionScan) => {
      if (message?.type !== 'kai-meet-notes' || message.key !== key) return;
      setCaptionsOn(message.captionsOn || !message.inCall);
      if (message.inCall) lastInCall.current = Date.now();
      const before = new Set(lines.current.map(l => l.id));
      lines.current = applyRows(lines.current, message.rows);
      for (const line of lines.current) if (!before.has(line.id)) fresh.current.add(line.id);
      dirty.current = true;
      render(n => n + 1);
      if (!message.inCall && lastInCall.current && Date.now() - lastInCall.current > LEFT_CALL_MS) void stopAndSave();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    // The lines are kept every 1.5 s, so a reopened panel carries on.
    const keep = setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      void notesStorage.set(current => (current?.key === key ? { ...current, lines: lines.current } : current));
    }, 1500);
    const onClosed = (tabId: number) => {
      if (tabId === session.tabId) void stopAndSave();
    };
    chrome.tabs.onRemoved.addListener(onClosed);
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.tabs.onRemoved.removeListener(onClosed);
      clearInterval(keep);
    };
  }, [session?.key, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow to the bottom as lines grow, unless scrolled up.
  useEffect(() => {
    const list = listRef.current;
    const content = list?.firstElementChild;
    if (!list || !content) return;
    const follow = new ResizeObserver(() => {
      if (atBottom.current) list.scrollTop = list.scrollHeight;
    });
    follow.observe(content);
    return () => follow.disconnect();
  }, [session?.key]);

  async function stopAndSave(): Promise<void> {
    const current = await notesStorage.get();
    if (!current || current.savedAt || busy) return;
    setBusy('saving');
    setError(null);
    try {
      await chrome.scripting.executeScript({ target: { tabId: current.tabId }, func: stopMeetNotes }).catch(() => {});
      const finished = { ...current, lines: lines.current };
      let summary: string | undefined;
      if (model && finished.lines.length) {
        const result = await generateText({
          model: model.model,
          system: SUMMARY_SYSTEM,
          prompt: summaryPrompt(finished, finished.lines),
          maxOutputTokens: 2_000,
          maxRetries: 1,
          ...(model.providerOptions ? { providerOptions: model.providerOptions as never } : {}),
        }).catch(() => null);
        summary = result?.text.trim() || undefined;
      }
      const ended = new Date();
      const saved: NotesSession = { ...finished, summary, savedAt: ended.toISOString() };
      await saveChatToCommandCenter(notesForCommandCenter(saved, ended));
      await notesStorage.set(saved);
    } catch (e) {
      setError(t('notes.saveFailed', { error: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  if (!session) return null;
  const shown = lines.current;
  const ask = () => {
    onAsk({
      text: question.trim() || t('meeting.summary'),
      title: session.title,
      url: null,
      details: notesQuote(session, shown),
    });
    setQuestion('');
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-nb-border/60 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('notes.title', { title: session.title })}</h2>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            session.savedAt ? 'bg-nb-surface text-nb-muted' : 'bg-green-500/15 text-green-600 dark:text-green-400'
          }`}>
          {session.savedAt ? t('notes.status.saved') : t('notes.status.live')}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 pt-2 text-[11px] text-nb-muted">
        {session.notice === 'posted' ? <p>{t('notes.notice.posted', { notice: CONSENT_NOTICE })}</p> : null}
        {session.notice === 'failed' ? (
          <p className="text-amber-500">{t('notes.notice.failed', { notice: CONSENT_NOTICE })}</p>
        ) : null}
        {!captionsOn && !session.savedAt ? <p className="text-amber-500">{t('notes.captionsOff')}</p> : null}
        {error ? <p className="text-red-500">{error}</p> : null}
        {session.savedAt ? <p>{t('notes.saved')}</p> : null}
      </div>
      <div
        ref={listRef}
        onScroll={e => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        aria-live="polite">
        <div>
          {session.summary ? (
            <div className="mb-3 whitespace-pre-wrap rounded-lg bg-nb-surface px-3 py-2 text-sm">{session.summary}</div>
          ) : null}
          {shown.length ? (
            <ul className="flex flex-col gap-1.5">
              {shown.map((line, i) => (
                <li key={line.id} className="text-sm">
                  <span className="mr-1.5 text-[11px] text-nb-muted">{notesClock(line.at)}</span>
                  <span className="mr-1 font-medium">{line.speaker || t('notes.someone')}:</span>
                  {fresh.current.has(line.id) && i >= shown.length - ANIMATED_LINES ? (
                    <Smooth id={line.id} text={line.text} />
                  ) : (
                    line.text
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-sm text-nb-muted">{t('notes.empty')}</p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-nb-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={question}
            placeholder={t('meeting.askPlaceholder')}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) ask();
            }}
            className="min-w-0 flex-1 rounded-lg border border-nb-border/70 bg-nb-bg px-2.5 py-1.5 text-sm outline-none focus:border-nb-accent"
          />
          <button
            type="button"
            onClick={ask}
            className="shrink-0 rounded-lg px-2.5 py-1.5 text-sm text-nb-accent hover:bg-nb-surface">
            {t('meeting.ask')}
          </button>
        </div>
        <div className="flex justify-end gap-2">
          {session.savedAt ? (
            <button
              type="button"
              onClick={() => void notesStorage.set(null)}
              className="rounded-lg px-2.5 py-1.5 text-xs text-nb-muted hover:bg-nb-surface hover:text-nb-fg">
              {t('meeting.close')}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy === 'saving'}
              onClick={() => void stopAndSave()}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-nb-accent hover:bg-nb-surface disabled:opacity-50">
              {busy === 'saving' ? <SpinnerIcon size={12} className="animate-spin" /> : null}
              {busy === 'saving' ? t('notes.saving') : t('notes.stop')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Smooth({ id, text }: { id: string; text: string }) {
  return <>{useSmoothText(`notes:${id}`, text, true)}</>;
}
