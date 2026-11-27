// Bash AI's notetaker, kept by the worker (Aaron 2026-11-27) so the notes and the recording go on when the side panel
// closes. The panel starts and stops a session and shows it (NotesView); this keeps it in `notesStorage`:
//
// - The words: the Meet tab's notes script (entrypoints/meet-notes.content.ts) reports Meet's caption feed, named
//   (store/meet-feed.ts). Meet's own recognition is so-so (Aaron 2026-11-27: "the transcriptions are bad"), so each
//   speaker's finished turn is transcribed again by OpenAI through Command Center from the recording's sound (the
//   last 150 s are kept), and its words replace Meet's when they fit (`fitsTurn`); the names stay Meet's. When the
//   feed isn't live 15 s into the call (the tab was opened before Bash AI loaded, or Meet changed its feed), the sound
//   is transcribed in 15-second clips instead, with no speaker names, until the feed comes back.
// - The recording: Chrome hands the worker the Meet tab (`tabCapture.getMediaStreamId`, allowed once the person has
//   clicked Bash AI's icon on that tab), and the offscreen document records it to Drive (ui/meeting-recorder.ts).
//   When Chrome refuses, the panel records it through Chrome's share picker instead, and then it lives in the panel.
// - The chat: when a finished turn names Bash AI and asks for something in Meet's chat ("Bash AI, put the action items
//   in the chat"), Claude writes it from the transcript only (store/meeting-chat.ts) and it is posted from the person's
//   account as "Bash AI: …", and kept in the notes.
// - The end: Stop and save, the tab closing, or 20 s out of the call. The recording's upload is finished and shared
//   with the person, Claude through Command Center writes the summary, and the notes go to Command Center.
import { generateText } from 'ai';
import { createModel } from '@src/llm/providers';
import { TEACH_MODEL } from '@src/llm/teach';
import { transcribeAudio } from '@src/llm/transcribe';
import {
  commandCenterFetch,
  commandCenterStorage,
  finishRecordingUpload,
  saveChatToCommandCenter,
  startRecordingUpload,
} from '@src/store/command-center';
import { commandCenterBaseUrl } from '@src/store/command-center-providers';
import type { FeedReport } from '@src/store/meet-feed';
import {
  CONSENT_NOTICE,
  SUMMARY_SYSTEM,
  addSoundLine,
  applyFeed,
  fitsTurn,
  foldTurn,
  keepTurn,
  meetTitle,
  notesForCommandCenter,
  notesStorage,
  notesText,
  summaryPrompt,
  turnsToPolish,
} from '@src/store/meeting-notes';
import type { NotesRecording, NotesSession, Turn } from '@src/store/meeting-notes';
import { CHAT_SYSTEM, NO_MESSAGE, chatPrompt, isAddressed, splitChatMessage } from '@src/store/meeting-chat';
import type { RecorderMessage } from '@src/ui/meeting-recorder';
import { ensureOffscreen } from './downloads';

/** Panel -> worker. */
export type NotesRequest =
  | { type: 'kai-notes'; op: 'start'; tab: { id: number; url: string; title: string } }
  | { type: 'kai-notes'; op: 'stop' }
  | { type: 'kai-notes'; op: 'recording'; key: string; withMic?: boolean; error?: string };

/** The feed must be live this long into the call, or the call's sound is transcribed instead. */
const FEED_GRACE_MS = 15_000;
/** Out of the call this long (after being in it): the notes stop and save themselves. */
const LEFT_CALL_MS = 20_000;
/** The language asked of Meet's captions. */
const CAPTION_LANGUAGE = 'en-US';

let session: NotesSession | null = null;
let loaded: Promise<void> | null = null;
let writing: ReturnType<typeof setTimeout> | null = null;
let lastInCall: number | null = null;
let firstInCall: number | null = null;
let stopping: Promise<void> | null = null;
/** Feed lines whose turn is being transcribed again. */
const polishing = new Set<string>();
/** Where the last transcribed slice of sound ended, so two turns never share words. */
let lastSliceEnd = 0;

const load = () =>
  (loaded ??= notesStorage.get().then(saved => {
    session ??= saved;
  }));

/** Changes the session and keeps it (written at most once a second). */
function update(change: (current: NotesSession) => NotesSession, now = false): void {
  if (!session) return;
  session = change(session);
  if (now) {
    if (writing) clearTimeout(writing);
    writing = null;
    void notesStorage.set(session);
    return;
  }
  writing ??= setTimeout(() => {
    writing = null;
    if (session) void notesStorage.set(session);
  }, 1000);
}

const setRecording = (recording: NotesRecording, now = true) =>
  update(current => ({ ...current, recording: { ...current.recording, ...recording } }), now);

const tellTab = (tabId: number, message: Record<string, unknown>) =>
  chrome.tabs.sendMessage(tabId, { type: 'kai-notes-tab', ...message });

/** The notes script in the tab: there since the page loaded, or added now (then the feed can't be tapped). */
async function reachTab(tabId: number): Promise<void> {
  const there = await tellTab(tabId, { op: 'ping' }).catch(() => null);
  if (there) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/meet-notes.js'] });
}

async function start(tab: {
  id: number;
  url: string;
  title: string;
}): Promise<{ key: string; capture: 'tab' | 'picker' }> {
  await load();
  if (session && !session.savedAt) throw new Error('Notes are already being taken.');
  const key = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  session = {
    key,
    meetUrl: tab.url,
    title: meetTitle(tab.title, tab.url),
    tabId: tab.id,
    startedAt: new Date().toISOString(),
    lines: [],
    notice: 'posting',
    feed: 'waiting',
    recording: { state: 'starting' },
  };
  lastInCall = firstInCall = null;
  stopping = null;
  polishing.clear();
  lastSliceEnd = 0;
  update(s => s, true);

  // Chrome hands the worker the tab only when the person has invoked Bash AI on it; asked first, so a refusal can
  // still be answered with the share picker while the panel's click counts.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }).catch(() => null);
  void (async () => {
    await reachTab(tab.id).catch(() => undefined);
    await tellTab(tab.id, { op: 'start', key, lang: CAPTION_LANGUAGE }).catch(() => undefined);
    const posted = (await tellTab(tab.id, { op: 'post-chat', text: CONSENT_NOTICE }).catch(() => null)) as {
      result?: string;
    } | null;
    if (session?.key === key) update(s => ({ ...s, notice: posted?.result === 'sent' ? 'posted' : 'failed' }), true);
  })();
  if (streamId) void recordInOffscreen(key, tab, streamId);
  return { key, capture: streamId ? 'tab' : 'picker' };
}

async function recordInOffscreen(key: string, tab: { title: string; url: string }, streamId: string): Promise<void> {
  try {
    const startedAt = session?.startedAt ?? new Date().toISOString();
    const upload = await startRecordingUpload({
      title: meetTitle(tab.title, tab.url),
      startedAt,
      mimeType: 'video/webm',
    });
    await ensureOffscreen();
    const answer = (await chrome.runtime.sendMessage({
      target: 'recorder',
      type: 'rec-start',
      key,
      streamId,
      uploadUrl: upload.uploadUrl,
    })) as { ok?: boolean; withMic?: boolean; error?: string } | undefined;
    if (!answer?.ok) throw new Error(answer?.error ?? 'The recorder did not start.');
    if (session?.key === key)
      setRecording({ state: 'recording', mode: 'tab', withMic: answer.withMic, startedAt: new Date().toISOString() });
  } catch (error) {
    if (session?.key === key) setRecording({ state: 'failed', error: (error as Error).message });
  }
}

/** A report from the Meet tab's feed. */
function onFeed(report: FeedReport): void {
  if (!session || session.key !== report.key || session.savedAt || session.saving) return;
  const now = Date.now();
  if (report.inCall) {
    lastInCall = now;
    firstInCall ??= now;
  }
  update(s => ({
    ...s,
    feed: report.feed,
    lines: applyFeed(s.lines, report.utterances, new Date(), new Set(s.folded)),
  }));
  void polishTurns(report.key);
  // The feed down 15 s into the call: transcribe the sound until it is back.
  const feedDown = report.feed !== 'live' && firstInCall !== null && now - firstInCall > FEED_GRACE_MS;
  if (feedDown !== Boolean(session.fromSound) && session.recording?.state === 'recording') {
    update(s => ({ ...s, fromSound: feedDown }), true);
    void chrome.runtime
      .sendMessage({ target: 'recorder', type: 'rec-transcribe', key: report.key, on: feedDown })
      .catch(() => undefined);
  }
  if (!report.inCall && lastInCall !== null && now - lastInCall > LEFT_CALL_MS) void stopAndSave();
}

/** Sound (base64 WAV) as text, through Command Center's transcription model; '' when it can't. */
async function transcribe(wav: string, prompt?: string): Promise<string> {
  const cc = await commandCenterStorage.get();
  const model = cc?.extras?.voice.transcription;
  if (!cc || !model) return '';
  const audio = Uint8Array.from(atob(wav), c => c.charCodeAt(0));
  return transcribeAudio(
    {
      kind: 'openai',
      modelName: model.name,
      apiKey: 'command-center',
      baseUrl: commandCenterBaseUrl(cc.url, 'openai'),
    },
    audio,
    { language: CAPTION_LANGUAGE, fetch: commandCenterFetch, prompt },
  ).catch(() => '');
}

/** A clip of the call's sound to transcribe (the feed is down). */
async function onClip(key: string, at: string, wav: string): Promise<void> {
  const text = await transcribe(wav);
  if (text && session?.key === key) update(s => ({ ...s, lines: addSoundLine(s.lines, at, text) }));
}

/** The words OpenAI should spell right: the company's terms and the speakers' names. */
function spellingHint(current: NotesSession): string {
  const names = [...new Set(current.lines.map(l => l.speaker).filter(Boolean))];
  return ['Kinetic Scaling, Bash AI, Command Center, ClickUp, GoHighLevel', ...names].join(', ');
}

/**
 * A speaker's finished turns: transcribed again from the recording's sound (Meet's words stay when OpenAI's don't fit,
 * or when the recording isn't running; the person's own turns need their microphone in it), then checked for a
 * request to Bash AI to post in the Meet chat.
 */
async function polishTurns(key: string): Promise<void> {
  const current = session;
  if (!current || current.key !== key || current.fromSound) return;
  const cc = await commandCenterStorage.get();
  const recording = current.recording?.state === 'recording' && Boolean(cc?.extras?.voice.transcription);
  const me = cc ? (cc.viewer?.name ?? cc.user.name).trim().toLowerCase() : '';
  for (const turn of turnsToPolish(session?.lines ?? [], Date.now(), polishing)) {
    for (const id of turn.ids) polishing.add(id);
    const ownWithoutMic = !current.recording?.withMic && turn.speaker.trim().toLowerCase() === me;
    const words = recording && !ownWithoutMic ? polishTurn(key, turn) : keepWords(turn);
    void words
      .then(text => heard(key, turn.speaker, text))
      .finally(() => {
        for (const id of turn.ids) polishing.delete(id);
      });
  }
}

/** The turn keeps Meet's words; answers them. */
async function keepWords(turn: Turn): Promise<string> {
  update(s => ({ ...s, lines: keepTurn(s.lines, turn) }));
  return turn.text;
}

/** Transcribes a turn again; answers the words it ends up with. */
async function polishTurn(key: string, turn: Turn): Promise<string> {
  // From 2 s before Meet's first words (its captions lag the voice) to just after its last, never into the last turn.
  const from = Math.max(turn.start - 2000, lastSliceEnd);
  const to = turn.end + 600;
  lastSliceEnd = Math.max(lastSliceEnd, to);
  const answer = (await chrome.runtime
    .sendMessage({ target: 'recorder', type: 'rec-slice', key, from, to })
    .catch(() => undefined)) as { wav?: string } | undefined;
  const text = answer?.wav && session ? await transcribe(answer.wav, spellingHint(session)) : '';
  if (session?.key !== key) return turn.text;
  if (text && fitsTurn(turn.text, text)) {
    update(s => ({ ...s, lines: foldTurn(s.lines, turn, text), folded: [...(s.folded ?? []), ...turn.ids] }));
    return text;
  }
  update(s => ({ ...s, lines: keepTurn(s.lines, turn) }));
  return turn.text;
}

/** Chat requests, one at a time. */
let chatQueue: Promise<void> = Promise.resolve();

/** A finished turn: when it names Bash AI and asks for something in the Meet chat, Bash AI posts it there. */
function heard(key: string, speaker: string, text: string): void {
  if (!isAddressed(text)) return;
  chatQueue = chatQueue.then(() => postRequested(key, speaker, text)).catch(() => undefined);
}

async function postRequested(key: string, speaker: string, request: string): Promise<void> {
  const current = session;
  const model = current?.key === key && !current.savedAt ? await summaryModel() : null;
  if (!current || !model) return;
  const result = await generateText({
    model: model.model,
    system: CHAT_SYSTEM,
    prompt: chatPrompt(current.title, notesText(current.lines, 40_000), speaker, request),
    maxOutputTokens: 800,
    maxRetries: 1,
    ...(model.providerOptions ? { providerOptions: model.providerOptions as never } : {}),
  }).catch(() => null);
  const message = result?.text.trim() ?? '';
  if (!message || message.includes(NO_MESSAGE) || session?.key !== key) return;
  let posted = true;
  for (const part of splitChatMessage(`Bash AI: ${message}`)) {
    const answer = (await tellTab(current.tabId, { op: 'post-chat', text: part }).catch(() => null)) as {
      result?: string;
    } | null;
    if (answer?.result !== 'sent') posted = false;
  }
  const at = new Date().toISOString();
  update(
    s => ({
      ...s,
      lines: [
        ...s.lines,
        {
          id: `c:${at}`,
          speaker: 'Bash AI',
          text: message,
          at,
          done: true,
          polished: true,
          chat: posted ? 'sent' : 'failed',
        },
      ],
    }),
    true,
  );
}

function onRecorder(message: RecorderMessage): void {
  if (!session || session.key !== message.key) return;
  if (message.event === 'progress')
    setRecording({ state: 'recording', recorded: message.recorded, sent: message.sent }, false);
  else if (message.event === 'clip' && message.at && message.wav) void onClip(message.key, message.at, message.wav);
  else if (message.event === 'ended') void finishRecording(message.key);
}

/** Claude through Command Center, for the summary; null when signed out or no Claude model is offered. */
async function summaryModel() {
  const cc = await commandCenterStorage.get();
  const claude = cc?.models.filter(m => m.provider === 'claude') ?? [];
  const name = (claude.find(m => m.name === TEACH_MODEL) ?? claude[0])?.name;
  if (!cc || !name) return null;
  return createModel(
    { kind: 'anthropic', modelName: name, apiKey: 'command-center', baseUrl: commandCenterBaseUrl(cc.url, 'claude') },
    { fetch: commandCenterFetch },
  );
}

/** Stops the recording, sends the rest to Drive, and shares it with the person. */
async function finishRecording(key: string): Promise<void> {
  const state = session?.recording?.state;
  if (state === 'starting') return setRecording({ state: 'failed', error: 'The recording did not start.' });
  if (state !== 'recording') return;
  setRecording({ state: 'saving' });
  const answer = (await chrome.runtime
    .sendMessage({ target: 'recorder', type: 'rec-stop', key })
    .catch(() => undefined)) as { fileId?: string; error?: string } | undefined;
  try {
    if (!answer) throw new Error('The recording stopped when the side panel closed.');
    if (!answer.fileId) throw new Error(answer.error ?? 'Drive did not confirm the recording.');
    const saved = await finishRecordingUpload(answer.fileId);
    if (session?.key === key) setRecording({ state: 'saved', url: saved.url });
  } catch (error) {
    if (session?.key === key) setRecording({ state: 'failed', error: (error as Error).message });
  }
}

/** Ends the session: the tab stops reporting, the recording is finished and shared, the summary written, all saved. */
function stopAndSave(): Promise<void> {
  if (!session || session.savedAt) return Promise.resolve();
  stopping ??= (async () => {
    const key = session!.key;
    update(s => ({ ...s, saving: true, saveError: undefined }), true);
    await tellTab(session!.tabId, { op: 'stop', key }).catch(() => undefined);
    await finishRecording(key);
    let summary: string | undefined;
    const model = session!.lines.length ? await summaryModel() : null;
    if (model) {
      const result = await generateText({
        model: model.model,
        system: SUMMARY_SYSTEM,
        prompt: summaryPrompt(session!, session!.lines),
        maxOutputTokens: 2_000,
        maxRetries: 1,
        ...(model.providerOptions ? { providerOptions: model.providerOptions as never } : {}),
      }).catch(() => null);
      summary = result?.text.trim() || undefined;
    }
    const ended = new Date();
    const finished: NotesSession = { ...session!, summary, saving: false, savedAt: ended.toISOString() };
    try {
      await saveChatToCommandCenter(notesForCommandCenter(finished, ended));
      session = finished;
    } catch (error) {
      session = { ...finished, savedAt: undefined, saveError: (error as Error).message };
    }
    update(s => s, true);
  })().finally(() => {
    stopping = null;
  });
  return stopping;
}

/** Listens for the panel, the Meet tab and the recorder. Registered at worker start. */
export function listenForNotes(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return undefined;
    const m = message as { type?: string };
    if (m?.type === 'kai-meet-feed') {
      void load().then(() => onFeed(message as FeedReport));
      return undefined;
    }
    if (m?.type === 'kai-rec') {
      void load().then(() => onRecorder(message as RecorderMessage));
      return undefined;
    }
    if (m?.type !== 'kai-notes') return undefined;
    const request = message as NotesRequest;
    const done =
      request.op === 'start'
        ? start(request.tab)
        : request.op === 'stop'
          ? load().then(stopAndSave)
          : load().then(() => {
              if (session?.key !== request.key) return;
              setRecording(
                request.error
                  ? { state: 'failed', error: request.error }
                  : {
                      state: 'recording',
                      mode: 'picker',
                      withMic: request.withMic,
                      startedAt: new Date().toISOString(),
                    },
              );
            });
    done.then(
      answer => reply({ ok: true, ...(answer ?? {}) }),
      (error: Error) => reply({ ok: false, error: error.message }),
    );
    return true;
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    void load().then(() => {
      if (session && !session.savedAt && session.tabId === tabId) void stopAndSave();
    });
  });
}
