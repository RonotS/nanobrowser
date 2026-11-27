// The Meeting view (Aaron 2026-11-26): send Bash AI into a Google Meet, follow what it hears in a live transcript,
// ask about the meeting in the chat, and remove it from the call. Bash AI joins by phone through the meeting bot
// (RonotS/meeting-bot): Command Center finds the meeting's phone number on the calendar invite (or the person pastes
// Meet's "Join by phone" line), and the bot answers in the meeting only when someone says "Bash AI". Internal meetings
// only. The transcript is read straight from the bot with the call's pass, every two seconds while the call is on.
import { useEffect, useRef, useState } from 'react';
import { useSmoothText } from './SmoothText';
import { CommandCenterError, MeetingNeedsDialInError, startMeetingBot } from '@src/store/command-center';
import {
  MeetingGoneError,
  leaveMeeting,
  lineClock,
  lineId,
  pendingLive,
  looksLikeDialIn,
  meetCallUrl,
  meetingStorage,
  mergeLines,
  readMeeting,
  transcriptQuote,
} from '@src/store/meeting-bot';
import type { FollowedMeeting, LiveMeetingLine, MeetingLine, MeetingStatus } from '@src/store/meeting-bot';
import { t } from '@src/ui/i18n';
import type { MessageKey } from '@src/ui/i18n';
import { SpinnerIcon } from '@src/ui/icons';
import type { SideAsk } from './side-view';
import { NotesView, startNotes } from './NotesView';
import { startRecording } from './recorder';
import { notesStorage } from '@src/store/meeting-notes';
import type { ChatModel } from '@src/llm/providers';

/**
 * While the call is on, the transcript is read often enough to stream (Aaron 2026-11-27: "when it is
 * streaming, make sure it is smooth"): new words show in under a second and are revealed at an even
 * pace, like the chat's answers.
 */
const POLL_MS = 700;
/** Only the newest lines animate (each animated line redraws every frame). */
const ANIMATED_LINES = 6;

/** The Meet call open in this window's active tab, if any. */
function useActiveMeet(): { id: number; url: string; title: string } | null {
  const [meet, setMeet] = useState<{ id: number; url: string; title: string } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then(([tab]) => {
          if (!live) return;
          const url = meetCallUrl(tab?.url);
          setMeet(url && tab?.id !== undefined ? { id: tab.id, url, title: tab.title ?? '' } : null);
        })
        .catch(() => live && setMeet(null));
    void read();
    const onActivated = () => void read();
    const onUpdated = (_id: number, change: { url?: string; status?: string }) => {
      if (change.url || change.status === 'complete') void read();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      live = false;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);
  return meet;
}

/** When the bot's call ended because it couldn't get in (declined, nobody admitted, Meet refused). */
const NOT_LET_IN = /declined|nobody admitted|refused|could not join|can't join/i;

export function MeetingView({ onAsk, model }: { onAsk: (ask: SideAsk) => void; model: ChatModel | null }) {
  const [meeting, setMeeting] = useState<FollowedMeeting | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<MeetingStatus>('calling');
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [lines, setLines] = useState<MeetingLine[]>([]);
  const [live, setLive] = useState<LiveMeetingLine[]>([]);
  /** Lines that arrived while this view was open: they reveal smoothly; the ones before show at once. */
  const fresh = useRef(new Set<string>());
  const firstRead = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'starting' | 'removing' | null>(null);
  const [needDialIn, setNeedDialIn] = useState(false);
  const [dialIn, setDialIn] = useState('');
  const [question, setQuestion] = useState('');
  const activeTab = useActiveMeet();
  const activeMeet = activeTab?.url ?? null;
  const [notesOn, setNotesOn] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  useEffect(() => {
    const read = () => void notesStorage.get().then(n => setNotesOn(Boolean(n)));
    read();
    return notesStorage.subscribe(read);
  }, []);
  const takeNotes = async () => {
    if (!activeTab) {
      setNotesError(t('notes.noMeet'));
      return;
    }
    setNotesError(null);
    // The recording starts first, straight from the click: tab capture and Chrome's share picker both need it.
    const recording = startRecording(activeTab.id, activeTab.title || activeTab.url).catch((e: unknown) =>
      e instanceof Error ? e : new Error(String(e)),
    );
    try {
      await startNotes(activeTab, recording);
    } catch (e) {
      setNotesError((e as Error).message);
    }
  };
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // The meeting the panel follows survives a panel reload.
  useEffect(() => {
    void meetingStorage.get().then(saved => {
      if (saved && Date.parse(saved.expiresAt) <= Date.now()) {
        void meetingStorage.set(null);
        saved = null;
      }
      setMeeting(saved);
      setLoaded(true);
    });
    return meetingStorage.subscribe(() => void meetingStorage.get().then(setMeeting));
  }, []);

  // A new meeting starts a new transcript.
  useEffect(() => {
    setLines([]);
    setLive([]);
    fresh.current = new Set();
    firstRead.current = true;
    setStatus('calling');
    setEndedReason(null);
  }, [meeting?.sessionId]);

  // The live transcript, every two seconds until the call ends.
  useEffect(() => {
    if (!meeting || status === 'ended') return;
    let live = true;
    let last = 0;
    const poll = async () => {
      try {
        const view = await readMeeting(meeting, last);
        if (!live) return;
        last = view.last;
        if (!firstRead.current) for (const line of view.lines) fresh.current.add(lineId(line));
        for (const piece of view.live ?? []) fresh.current.add(piece.key);
        firstRead.current = false;
        setLines(current => mergeLines(current, view.lines));
        setLive(view.live ?? []);
        setStatus(view.status);
        setEndedReason(view.endedReason);
        setError(null);
      } catch (e) {
        if (!live) return;
        if (e instanceof MeetingGoneError) {
          setStatus('ended');
          setEndedReason(t('meeting.gone'));
        } else setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [meeting, status === 'ended']); // eslint-disable-line react-hooks/exhaustive-deps

  const hasTranscript = lines.length > 0 || live.length > 0;
  // Stay at the bottom while words stream in (they grow a line at a time), unless the person scrolled up.
  useEffect(() => {
    const list = listRef.current;
    const content = list?.firstElementChild;
    if (!list || !content) return;
    const follow = new ResizeObserver(() => {
      if (atBottom.current) list.scrollTop = list.scrollHeight;
    });
    follow.observe(content);
    return () => follow.disconnect();
  }, [meeting?.sessionId, hasTranscript]);

  const send = async () => {
    setBusy('starting');
    setError(null);
    try {
      const pasted = dialIn.trim();
      const started = await startMeetingBot({ meetUrl: activeMeet ?? undefined, dialIn: pasted || undefined });
      const followed: FollowedMeeting = {
        sessionId: started.sessionId,
        botUrl: started.botUrl,
        grant: started.grant,
        expiresAt: started.expiresAt,
        title: started.title,
        invited: started.invited,
        meetUrl: activeMeet,
        startedAt: new Date().toISOString(),
      };
      await meetingStorage.set(followed);
      setMeeting(followed);
      setNeedDialIn(false);
      setDialIn('');
    } catch (e) {
      if (e instanceof MeetingNeedsDialInError) setNeedDialIn(true);
      setError(e instanceof CommandCenterError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!meeting) return;
    setBusy('removing');
    try {
      const view = await leaveMeeting(meeting);
      setStatus(view.status);
      setEndedReason(view.endedReason);
    } catch (e) {
      if (e instanceof MeetingGoneError) {
        setStatus('ended');
        setEndedReason(t('meeting.gone'));
      } else setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const ask = () => {
    if (!meeting) return;
    onAsk({
      text: question.trim() || t('meeting.summary'),
      title: meeting.title ?? t('meeting.untitled'),
      // No tab: opening the Meet link again would join the meeting a second time.
      url: null,
      details: transcriptQuote(meeting, lines),
    });
    setQuestion('');
  };

  if (!loaded) return <p className="px-3 py-4 text-sm text-nb-muted">{t('side.loading')}</p>;
  if (notesOn) return <NotesView model={model} onAsk={onAsk} />;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-nb-border/60 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {meeting ? (meeting.title ?? t('meeting.untitled')) : t('rail.meeting')}
        </h2>
        {meeting ? <StatusBadge status={status} /> : null}
      </div>

      {error ? (
        <p role="alert" className="mx-3 mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error}
        </p>
      ) : null}

      {!meeting ? (
        <div className="flex flex-col gap-3 p-3 text-sm">
          <p className="text-nb-muted">{t('meeting.intro')}</p>
          {activeMeet ? (
            <p className="rounded-lg bg-nb-surface px-3 py-2 text-xs">
              {t('meeting.thisMeet', { url: activeMeet.replace('https://', '') })}
            </p>
          ) : (
            <p className="rounded-lg bg-nb-surface px-3 py-2 text-xs text-nb-muted">{t('meeting.openMeet')}</p>
          )}
          {needDialIn || !activeMeet ? (
            <label className="flex flex-col gap-1 text-xs text-nb-muted">
              {t('meeting.dialInLabel')}
              <textarea
                value={dialIn}
                rows={2}
                placeholder={t('meeting.dialInPlaceholder')}
                onChange={e => setDialIn(e.target.value)}
                className="rounded-lg border border-nb-border/70 bg-nb-bg px-2.5 py-1.5 text-sm text-nb-fg outline-none focus:border-nb-accent"
              />
            </label>
          ) : null}
          {notesError ? <p className="text-xs text-red-500">{notesError}</p> : null}
          <button
            type="button"
            disabled={!activeTab}
            onClick={() => void takeNotes()}
            className="rounded-lg border border-nb-border/70 px-3 py-2 text-sm text-nb-fg transition-colors hover:bg-nb-surface disabled:cursor-not-allowed disabled:opacity-50">
            {t('meeting.takeNotes')}
          </button>
          <button
            type="button"
            disabled={busy === 'starting' || (!activeMeet && !looksLikeDialIn(dialIn))}
            onClick={() => void send()}
            className="flex items-center justify-center gap-2 rounded-lg bg-nb-accent px-3 py-2 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'starting' ? <SpinnerIcon size={14} className="animate-spin" /> : null}
            {busy === 'starting' ? t('meeting.sending') : t('meeting.send')}
          </button>
          <p className="text-[11px] text-nb-muted">{t('meeting.rules')}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1 px-3 pt-2 text-[11px] text-nb-muted">
            {status === 'lobby' ? <p className="text-amber-500">{t('meeting.admit')}</p> : null}
            {status === 'ended' ? <p>{t('meeting.left', { reason: endedReason ?? '' })}</p> : null}
            {status === 'ended' && NOT_LET_IN.test(endedReason ?? '') && activeTab ? (
              <button
                type="button"
                onClick={() => void takeNotes()}
                className="self-start rounded-lg border border-nb-border/70 px-2.5 py-1.5 text-xs text-nb-fg hover:bg-nb-surface">
                {t('meeting.takeNotesInstead')}
              </button>
            ) : null}
            {meeting.invited.length ? (
              <p className="truncate" title={meeting.invited.join('\n')}>
                {t('meeting.invited', { names: meeting.invited.join('; ') })}
              </p>
            ) : null}
            <p>{t('meeting.phoneNote')}</p>
          </div>
          <div
            ref={listRef}
            onScroll={e => {
              const el = e.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
            aria-live="polite">
            {lines.length || live.length ? (
              <ul className="flex flex-col gap-1.5">
                {lines.map((line, i) => (
                  <TranscriptLine
                    key={lineId(line)}
                    id={lineId(line)}
                    who={line.who}
                    at={line.at}
                    text={line.text}
                    animate={fresh.current.has(lineId(line)) && i >= lines.length - ANIMATED_LINES}
                  />
                ))}
                {pendingLive(live, lines).map(piece => (
                  <TranscriptLine
                    key={piece.key}
                    id={piece.key}
                    who={piece.who}
                    at={piece.at}
                    text={piece.text}
                    animate
                  />
                ))}
              </ul>
            ) : (
              <p className="py-4 text-sm text-nb-muted">{t('meeting.empty')}</p>
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
                className="shrink-0 rounded-lg px-2.5 py-1.5 text-sm text-nb-accent hover:bg-nb-surface">
                {t('meeting.ask')}
              </button>
            </div>
            <div className="flex justify-end gap-2">
              {status === 'ended' ? (
                <button
                  type="button"
                  onClick={() => void meetingStorage.set(null)}
                  className="rounded-lg px-2.5 py-1.5 text-xs text-nb-muted hover:bg-nb-surface hover:text-nb-fg">
                  {t('meeting.close')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy === 'removing'}
                  onClick={() => void remove()}
                  className="rounded-lg px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-50">
                  {busy === 'removing' ? t('meeting.removing') : t('meeting.remove')}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** One line of the transcript. A new one reveals at an even pace (useSmoothText), carrying on from its words in progress. */
function TranscriptLine({
  id,
  who,
  at,
  text,
  animate,
}: {
  id: string;
  who: MeetingLine['who'];
  at: string;
  text: string;
  animate: boolean;
}) {
  return (
    <li className={who === 'note' ? 'text-[11px] italic text-nb-muted' : 'text-sm'}>
      <span className="mr-1.5 text-[11px] text-nb-muted">{lineClock(at)}</span>
      {who === 'note' ? null : (
        <span className={`mr-1 font-medium ${who === 'bash-ai' ? 'text-nb-accent' : ''}`}>
          {who === 'bash-ai' ? 'Bash AI' : t('meeting.who.meeting')}:
        </span>
      )}
      {animate ? <SmoothSpan id={id} text={text} /> : text}
    </li>
  );
}

function SmoothSpan({ id, text }: { id: string; text: string }) {
  return <>{useSmoothText(`meeting:${id}`, text, true)}</>;
}

function StatusBadge({ status }: { status: MeetingStatus }) {
  const tone =
    status === 'in-call'
      ? 'bg-green-500/15 text-green-600 dark:text-green-400'
      : status === 'lobby'
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : status === 'ended'
          ? 'bg-nb-surface text-nb-muted'
          : 'bg-nb-accent/15 text-nb-accent';
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {t(`meeting.status.${status}` as MessageKey)}
    </span>
  );
}
