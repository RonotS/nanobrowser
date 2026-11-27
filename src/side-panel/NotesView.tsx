// Bash AI's notetaker in the side panel (Aaron 2026-11-27): shows the notes the worker keeps (src/extension/meet-notes.ts)
// from the person's own Google Meet tab, no bot in the call. Meet's caption feed gives a named transcript without its
// captions box; the recording runs with a timer; a question about the meeting goes to the chat; Stop and save asks the
// worker to finish. Closing the panel stops nothing (except a recording made through Chrome's share picker).
import { Fragment, useEffect, useRef, useState } from 'react';
import { notesClock, notesQuote, notesStorage, speakerBlocks } from '@src/store/meeting-notes';
import type { NotesSession } from '@src/store/meeting-notes';
import { useStorage } from '@src/ui/hooks';
import { t } from '@src/ui/i18n';
import { SpinnerIcon } from '@src/ui/icons';
import { useSmoothText } from './SmoothText';
import type { SideAsk } from './side-view';

const ANIMATED_LINES = 6;

/** "12:04", or "1:02:09" past an hour. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** "45.2 MB". */
export function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function NotesView({ onAsk }: { onAsk: (ask: SideAsk) => void }) {
  const session = useStorage(notesStorage, null);
  const [question, setQuestion] = useState('');
  const [stopping, setStopping] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Lines that were there when the view opened show at once; new ones reveal smoothly.
  if (session && !seen.current) seen.current = new Set(session.lines.map(l => l.id));

  // Stay at the bottom as lines come in, unless the person scrolled up.
  const lineCount = session?.lines.length ?? 0;
  const lastText = session?.lines.at(-1)?.text;
  useEffect(() => {
    const list = listRef.current;
    if (list && atBottom.current) list.scrollTop = list.scrollHeight;
  }, [lineCount, lastText]);

  if (!session) return null;
  const live = !session.savedAt;
  const recent = new Set(session.lines.slice(-ANIMATED_LINES).map(l => l.id));
  const ask = () => {
    onAsk({
      text: question.trim() || t('meeting.summary'),
      title: session.title,
      url: null,
      details: notesQuote(session, session.lines),
    });
    setQuestion('');
  };
  const stop = () => {
    setStopping(true);
    void chrome.runtime.sendMessage({ type: 'kai-notes', op: 'stop' }).finally(() => setStopping(false));
  };
  const busy = stopping || Boolean(session.saving);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-nb-border/60 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('notes.title', { title: session.title })}</h2>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            live ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-nb-surface text-nb-muted'
          }`}>
          {!live ? t('notes.status.saved') : session.saving ? t('notes.status.saving') : t('notes.status.live')}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 pt-2 text-[11px] text-nb-muted">
        <RecordingLine recording={session.recording} />
        {session.fromSound ? <p className="text-amber-500">{t('notes.fromSound')}</p> : null}
        {live && session.feed === 'no-hook' ? <p className="text-amber-500">{t('notes.reloadForNames')}</p> : null}
        {session.notice === 'failed' ? <p className="text-amber-500">{t('notes.notice.failed')}</p> : null}
        {session.saveError ? (
          <p className="text-red-500">{t('notes.saveFailed', { error: session.saveError })}</p>
        ) : null}
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
        {session.summary ? (
          <div className="mb-3 whitespace-pre-wrap rounded-lg bg-nb-surface px-3 py-2 text-sm">{session.summary}</div>
        ) : null}
        {session.lines.length ? (
          <ul className="flex flex-col gap-2">
            {speakerBlocks(session.lines).map(block => (
              <li key={block.lines[0].id} className="text-sm leading-relaxed">
                <span className="mr-1.5 text-[11px] text-nb-muted">{notesClock(block.at)}</span>
                <span className="mr-1 font-medium">{block.speaker || t('meeting.who.meeting')}:</span>
                {block.lines.map((line, i) => (
                  <Fragment key={line.id}>
                    {i ? ' ' : ''}
                    {/* New words reveal smoothly; a turn OpenAI wrote again replaces Meet's words at once. */}
                    {!line.polished && !seen.current?.has(line.id) && recent.has(line.id) ? (
                      <Smooth id={line.id} text={line.text} />
                    ) : (
                      line.text
                    )}
                    {line.chat ? (
                      <span className={`ml-1 text-[11px] ${line.chat === 'sent' ? 'text-nb-muted' : 'text-amber-500'}`}>
                        · {line.chat === 'sent' ? t('notes.chat.sent') : t('notes.chat.failed')}
                      </span>
                    ) : null}
                  </Fragment>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-sm text-nb-muted">{t('notes.empty')}</p>
        )}
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
            className="shrink-0 cursor-pointer rounded-lg px-2.5 py-1.5 text-sm text-nb-accent hover:bg-nb-surface">
            {t('meeting.ask')}
          </button>
        </div>
        <div className="flex justify-end gap-2">
          {live ? (
            <button
              type="button"
              disabled={busy}
              onClick={stop}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-nb-accent hover:bg-nb-surface disabled:cursor-not-allowed disabled:opacity-60">
              {busy ? <SpinnerIcon size={12} className="animate-spin" /> : null}
              {busy ? t('notes.saving') : session.saveError ? t('notes.retry') : t('notes.stop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void notesStorage.set(null)}
              className="cursor-pointer rounded-lg px-2.5 py-1.5 text-xs text-nb-muted hover:bg-nb-surface hover:text-nb-fg">
              {t('meeting.close')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Whether it is recording, for how long, and how much: a red REC line with a running timer. */
function RecordingLine({ recording }: { recording: NotesSession['recording'] }) {
  const [now, setNow] = useState(Date.now());
  const on = recording?.state === 'recording';
  useEffect(() => {
    if (!on) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [on]);
  if (!recording || recording.state === 'starting') return <p>{t('notes.rec.starting')}</p>;
  if (recording.state === 'recording') {
    const since = recording.startedAt ? Date.parse(recording.startedAt) : now;
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 font-medium text-red-500">
        <span className="inline-block size-2 animate-pulse rounded-full bg-red-500" aria-hidden />
        {t('notes.rec.on', { time: elapsed(now - since), size: megabytes(recording.recorded ?? 0) })}
        {recording.withMic === false ? (
          <span className="font-normal text-amber-500">
            · {t('notes.rec.noMic')}{' '}
            <button
              type="button"
              onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('/permission.html') })}
              className="cursor-pointer text-nb-accent underline">
              {t('notes.rec.allowMic')}
            </button>
          </span>
        ) : null}
      </p>
    );
  }
  if (recording.state === 'saving') return <p>{t('notes.rec.saving')}</p>;
  if (recording.state === 'saved' && recording.url)
    return (
      <p>
        {t('notes.rec.saved')}{' '}
        <a href={recording.url} target="_blank" rel="noreferrer" className="text-nb-accent underline">
          {t('notes.rec.open')}
        </a>
      </p>
    );
  return <p className="text-amber-500">{t('notes.rec.failed', { error: recording.error ?? '' })}</p>;
}

function Smooth({ id, text }: { id: string; text: string }) {
  return <>{useSmoothText(`notes:${id}`, text, true)}</>;
}
