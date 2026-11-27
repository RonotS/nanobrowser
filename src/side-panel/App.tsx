// The side panel. A view: it draws the worker's events and sends commands; it holds no state a run depends on, and it
// never reads the conversation stores.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { capabilityOf, DEFAULT_SETTINGS, keysStorage, providersStorage, settingsStorage } from '@src/store/settings';
import type { ProviderConfig } from '@src/store/settings';
import type { LivePair, ModelRef, PermissionMode } from '@src/store/types';
import { makePair } from '@src/llm/profiles';
import type { ReasoningEffort } from '@src/llm/catalogue';
import { useStorage } from '@src/ui/hooks';
import { setLanguage, t, useLanguage } from '@src/ui/i18n';
import { applyTheme } from '@src/ui/theme';
import { PanelClient, panelTabId } from './client';
import { Composer, pickModel, sameModel } from './Composer';
import type { LauncherItem, ModelChoice, PendingFile } from './Composer';
import { attachmentKind, MAX_FILE, MAX_FILES } from '@src/store/attachments';
import { voiceLanguage, voiceSetup } from '@src/ui/voice';
import { transcribeAudio } from '@src/llm/transcribe';
import { newId, putBlob } from '@src/store/conversations';
import { INITIAL, isActive, reduce } from './state';
import { Transcript } from './Transcript';
import { HistoryDrawer } from './History';
import { Cards, containsCardNumber } from './Cards';
import { NoticeCard } from './NoticeCard';
import { WhatsNewCard, useWhatsNew } from './WhatsNewCard';
import { ratingMovedOn, useRatingCard } from './RatingCard';
import { TabBar } from './TabBar';
import { QueueList, RunBar } from './RunControls';
import type { MessageKey } from '@src/ui/i18n';
import type { PanelCommand } from '@src/ui/protocol';
import en from '@src/ui/locales/en.json';
import { installTestHook } from './test-hook';
import type { SavedShortcut } from '@src/store/shortcuts';
import { useShortcuts } from '@src/ui/shortcuts';
import { AutoNotice } from '@src/ui/auto-notice';
import {
  HistoryIcon,
  LogoMark,
  MoonIcon,
  NewChatIcon,
  SettingsIcon,
  SunIcon,
  TemporaryIcon,
  VoiceIcon,
} from '@src/ui/icons';
import { VoiceBar } from './VoiceBar';
import { roleLabel } from './role-label';
import {
  commandCenterFetch,
  commandCenterStorage,
  commandCenterUrl,
  readPanelViews,
  setViewAs,
  signInToCommandCenter,
  viewAsNoticeStorage,
} from '@src/store/command-center';
import type { PanelPrepCall, PanelView } from '@src/store/command-center';
import { commandCenterBaseUrl } from '@src/store/command-center-providers';
import type { TranscriptionSpec } from '@src/llm/transcribe';
import { createModel } from '@src/llm/providers';
import type { ChatModel } from '@src/llm/providers';
import { TEACH_MODEL } from '@src/llm/teach';
import { TeachVideo } from './TeachVideo';
import { PanelRail } from './PanelRail';
import { MeetingView } from './MeetingView';
import { meetingStorage } from '@src/store/meeting-bot';
import { notesStorage } from '@src/store/meeting-notes';
import type { RailView } from './PanelRail';
import { SideView } from './SideView';
import { clock, prepDetails } from './side-view';
import type { SideAsk } from './side-view';
import type { VoiceTopic } from './VoiceBar';

const NO_PROVIDERS: ProviderConfig[] = [];
const NO_KEYS: Record<string, string> = {};

/** The starters a new conversation offers when no shortcut is pinned: a short label and the text it sends. */
// Company tasks: they lean on Command Center, which is what sets Bash AI apart from a plain browser agent.
const STARTERS = [
  { label: 'panel.starter.clients', text: 'panel.starter.clientsText' },
  { label: 'panel.starter.sop', text: 'panel.starter.sopText' },
  { label: 'panel.starter.summarize', text: 'panel.starter.summarizeText' },
] as const;

/**
 * Brings a conversation's own tab to the front with its panel open. `sidePanel.open` needs the user's gesture, so it is
 * called before any await; the conversation's panel is already enabled on its tabs.
 */
function showTab(tabId: number): void {
  chrome.sidePanel.open({ tabId }).catch(() => undefined);
  void chrome.tabs
    .update(tabId, { active: true })
    .then(tab => (tab ? chrome.windows.update(tab.windowId, { focused: true }) : undefined))
    .catch(() => undefined);
}

/** Saves text as a file from the panel, through an anchor's download. */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  useLanguage();
  const settings = useStorage(settingsStorage, DEFAULT_SETTINGS);
  const providers = useStorage(providersStorage, NO_PROVIDERS);
  // The no-model card waits for the providers to be read, so it does not flash while the panel opens.
  const providersRead = useSyncExternalStore(providersStorage.subscribe, () => providersStorage.getSnapshot() !== null);
  const apiKeys = useStorage(keysStorage, NO_KEYS);
  const whatsNew = useWhatsNew();
  // Voice input: through Command Center's transcription model when signed in (the company's key, added by Command
  // Center), else the voice model chosen in Settings with its own key.
  const commandCenter = useStorage(commandCenterStorage, null);
  /** Why a view-as ended without the person ending it: Command Center refused the member. */
  const viewAsNotice = useStorage(viewAsNoticeStorage, null);
  const ccTranscription = commandCenter?.extras?.voice.transcription;
  const voice: TranscriptionSpec | null = ccTranscription
    ? {
        kind: 'openai',
        modelName: ccTranscription.name,
        apiKey: 'command-center',
        baseUrl: commandCenterBaseUrl(commandCenter.url, 'openai'),
      }
    : voiceSetup(settings, providers, apiKeys);
  const transcribe = voice
    ? (audio: Uint8Array) => {
        client?.send({ type: 'voice-used' });
        return transcribeAudio(voice, audio, {
          language: voiceLanguage(settings.dictationLanguage),
          ...(ccTranscription ? { fetch: commandCenterFetch } : {}),
        });
      }
    : null;
  // "Teach from a video": Claude through Command Center writes the SOP draft, and Command Center's transcription reads
  // the narration (none: the steps come from the stills alone). Only for someone signed in to Command Center.
  const [teachFile, setTeachFile] = useState<File | null>(null);
  const teachModelName = commandCenter
    ? (
        commandCenter.models.find(m => m.provider === 'claude' && m.name === TEACH_MODEL) ??
        commandCenter.models.find(m => m.provider === 'claude')
      )?.name
    : undefined;
  const teachUrl = commandCenter?.url;
  const teachModel = useMemo<ChatModel | null>(
    () =>
      teachUrl && teachModelName
        ? createModel(
            {
              kind: 'anthropic',
              modelName: teachModelName,
              apiKey: 'command-center',
              baseUrl: commandCenterBaseUrl(teachUrl, 'claude'),
            },
            { fetch: commandCenterFetch },
          )
        : null,
    [teachUrl, teachModelName],
  );
  const teachTranscribe =
    voice && ccTranscription
      ? (audio: Uint8Array) =>
          transcribeAudio(voice, audio, {
            language: voiceLanguage(settings.dictationLanguage),
            fetch: commandCenterFetch,
          })
      : null;
  const [client, setClient] = useState<PanelClient | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [state, dispatch] = useReducer(reduce, INITIAL);
  // Mode, model and effort chosen before the first message of a new conversation.
  const [draftMode, setDraftMode] = useState<PermissionMode | null>(null);
  const [draftPair, setDraftPair] = useState<LivePair | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** The voice agent's bar is open. */
  const [voiceOpen, setVoiceOpen] = useState(false);
  /** What a voice call started from the side panel is about (a meeting's Talk it through). */
  const [voiceTopic, setVoiceTopic] = useState<VoiceTopic | null>(null);
  const shortcuts = useShortcuts();
  const [autoNotice, setAutoNotice] = useState(false);
  /** A message held back because it looks like a card number. */
  const [held, setHeld] = useState<string | null>(null);
  /** Tabs picked with @ before the conversation exists; shared with the first message. */
  const [pendingTabs, setPendingTabs] = useState<Array<{ tabId: number; title: string }>>([]);
  const [confirmNewChat, setConfirmNewChat] = useState(false);
  /** The next chat is a temporary one (before its first message; after it, the conversation says so). */
  const [temporaryDraft, setTemporaryDraft] = useState(false);
  /** Text to put back into the composer: queued messages returned on Stop, or one taken back to edit. */
  const [draft, setDraft] = useState('');
  // The side views (PanelRail): which ones Command Center opens to this person's role, and the one shown.
  const [railViews, setRailViews] = useState<PanelView[]>([]);
  const [view, setView] = useState<RailView>('chat');
  /** Bash AI is in a meeting this panel follows (the Meeting view's dot). */
  const [inMeeting, setInMeeting] = useState(false);
  useEffect(() => {
    const read = () =>
      void meetingStorage.get().then(m => setInMeeting(Boolean(m && Date.parse(m.expiresAt) > Date.now())));
    read();
    return meetingStorage.subscribe(read);
  }, []);
  /** Notes are being taken in a Meet (the worker keeps them going on any view): a flashing red dot on Meeting. */
  const notes = useStorage(notesStorage, null);
  const notesLive = notes && !notes.savedAt ? (notes.recording?.state === 'recording' ? 'recording' : 'notes') : null;
  /** Files attached to the next message, already in the blob store. */
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Selections arrive from the context menu as quote chips for the next message.
  const [quotes, setQuotes] = useState<Array<{ text: string; url: string; title: string }>>([]);
  const quotesTaken = useRef(0);
  useEffect(() => {
    const fresh = state.selections.slice(quotesTaken.current);
    quotesTaken.current = state.selections.length;
    if (fresh.length) setQuotes(current => [...current, ...fresh]);
  }, [state.selections]);
  // A screenshot of the tab arrives from the worker as a file for the next message.
  const taken = useRef(0);
  useEffect(() => {
    const fresh = state.attached.slice(taken.current);
    taken.current = state.attached.length;
    // Never past the cap, even when a screenshot arrives after other files filled the message.
    if (fresh.length) setFiles(current => [...current, ...fresh].slice(0, MAX_FILES));
  }, [state.attached]);
  const clearFiles = () => {
    for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles([]);
    setAttachError(null);
  };
  /**
   * The panel writes an attached file to the blob store itself, since a port carries JSON, and sends its id; the
   * worker checks it again and moves it to the conversation when the message is sent.
   */
  const attach = async (list: File[]) => {
    setAttachError(null);
    let room = MAX_FILES - files.length;
    for (const file of list) {
      if (room <= 0) {
        setAttachError(t('composer.attachFull', { count: MAX_FILES }));
        break;
      }
      const kind = attachmentKind(file.name, file.type);
      if ('refused' in kind) {
        setAttachError(t(`attach.refused.${kind.reason}`, { name: file.name }));
        continue;
      }
      if (file.size > MAX_FILE) {
        setAttachError(t('composer.attachTooLarge', { name: file.name }));
        continue;
      }
      const ref = { id: newId(), name: file.name || 'pasted-image.png', mimeType: file.type, size: file.size };
      try {
        await putBlob({ ...ref, conversationId: '', data: file, createdAt: new Date().toISOString() });
      } catch {
        setAttachError(t('composer.attachFailed', { name: file.name }));
        continue;
      }
      room--;
      // Two drops at once each counted the chips before either was added: the cap holds here too.
      setFiles(current =>
        [...current, { ref, ...(kind.kind === 'image' ? { preview: URL.createObjectURL(file) } : {}) }].slice(
          0,
          MAX_FILES,
        ),
      );
    }
  };
  useEffect(() => {
    if (state.returned.length) setDraft(state.returned.map(q => q.text).join('\n'));
  }, [state.returned]);
  const queryHistory = useCallback((query: string) => client?.send({ type: 'history', query }), [client]);

  useEffect(() => void setLanguage(settings.uiLanguage), [settings.uiLanguage]);
  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  // Whether the panel is dark now: chosen, or following a dark system.
  const dark =
    settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    let created: PanelClient | null = null;
    panelTabId()
      .then(tabId => {
        installTestHook(tabId);
        created = new PanelClient(tabId);
        created.onEvent(event => {
          // An export arrives as Markdown for this panel, and is saved as a file.
          if (event.type === 'export') downloadText(event.filename, event.markdown);
          dispatch(event);
        });
        created.subscribe();
        setClient(created);
      })
      .catch(error => setFailure(String(error)));
    return () => created?.close();
  }, []);

  const models: ModelChoice[] = useMemo(
    () =>
      providers.flatMap(p =>
        p.models
          .filter(m => !m.noToolCalling)
          .map(m => {
            const ref = { providerId: p.id, model: m.name };
            return { ref, label: `${m.name} · ${p.name}`, name: m.name, capability: capabilityOf(providers, ref) };
          }),
      ),
    [providers],
  );

  const conversation = state.conversation;
  /** A temporary chat: never saved, deleted once left (src/extension/temporary.ts). */
  const temporary = conversation ? !!conversation.temporary : temporaryDraft;
  const mode: PermissionMode = conversation?.mode ?? draftMode ?? settings.defaultMode;
  // The conversation's live pair, the draft of a new chat, or one made from the settings. A model that is no longer
  // configured falls back to the default model, then to the first one there is.
  const fallback = pickModel(models, settings.defaultModel);
  const made = fallback ? makePair(fallback, settings.reasoning, capabilityOf(providers, fallback)) : null;
  const pair = state.live ?? (!state.conversationId ? draftPair : null) ?? made;
  // A new chat makes its pair once, when the settings and providers are read, and holds it as its draft until the first
  // message, even if another tab changes the defaults meanwhile.
  const settingsRead = useSyncExternalStore(settingsStorage.subscribe, () => settingsStorage.getSnapshot() !== null);
  useEffect(() => {
    if (state.conversationId) setDraftPair(null);
    else if (!draftPair && made && settingsRead && providersRead) setDraftPair(made);
  }, [state.conversationId, draftPair, made, settingsRead, providersRead]);
  const model = pickModel(models, pair?.model, settings.defaultModel);
  const reasoning: ReasoningEffort = pair?.reasoning ?? 'none';
  /** A model or effort chosen in the picker: the conversation's, or the draft's; the latest is the default too. */
  const choose = (next: LivePair) => {
    if (state.conversationId) {
      client?.send({ type: 'set-model', conversationId: state.conversationId, ...next });
      return;
    }
    setDraftPair(next);
    void settingsStorage.set(s => ({ ...s, defaultModel: next.model, reasoning: next.reasoning }));
  };
  const active = isActive(state.status);
  const ratingCard = useRatingCard(state.conversationId, state.startedAt, active, !!whatsNew);
  /** Sends a command the user gave that starts a run; with the rating card showing, it is their Maybe later. */
  const startRun = (command: PanelCommand) => {
    if (ratingCard) ratingMovedOn();
    client?.send(command);
  };
  const history = state.entries.filter(e => e.kind === 'user').map(e => (e as { text: string }).text);

  /**
   * The mode for this conversation, or the next one; the latest choice is the default for new conversations too. The
   * first switch to Auto explains it once.
   */
  const changeMode = (next: PermissionMode) => {
    if (next === 'auto' && !settings.autoNoticeShown) setAutoNotice(true);
    if (state.conversationId) {
      client?.send({ type: 'set-mode', conversationId: state.conversationId, mode: next });
      return;
    }
    setDraftMode(next);
    void settingsStorage.set(s => ({ ...s, defaultMode: next }));
  };
  const keys = useRef({ changeMode, mode });
  keys.current = { changeMode, mode };

  // The panel's keys. Esc stops the run; a focused write card, the launcher, a menu or a dialog takes it first.
  // Ctrl/Cmd+/ focuses the input, and Ctrl/Cmd+Shift+P switches the mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key === '/') {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>('#nb-composer-input')?.focus();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        keys.current.changeMode(keys.current.mode === 'ask' ? 'auto' : 'ask');
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]') || document.activeElement?.closest('[role="menu"]')) return;
      if (isActive(state.status) && state.conversationId && client) {
        client.send({ type: 'stop', conversationId: state.conversationId });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.status, state.conversationId, client]);

  const newChat = (confirmed = false) => {
    if (isActive(state.status) && !confirmed) {
      setConfirmNewChat(true);
      return;
    }
    setConfirmNewChat(false);
    setDraftMode(null);
    setDraftPair(null);
    setPendingTabs([]);
    setTemporaryDraft(false);
    if (client) client.send({ type: 'new-chat', tabId: client.tabId });
  };

  /**
   * Starts a temporary chat, or leaves one for a normal new chat. Leaving it is what deletes it: the worker drops a
   * temporary conversation once no panel shows it. Not offered while a task runs, so it never has to ask first.
   */
  const toggleTemporary = () => {
    if (temporary) {
      if (state.conversationId) newChat();
      else setTemporaryDraft(false);
      return;
    }
    if (state.conversationId) newChat();
    setTemporaryDraft(true);
  };

  /**
   * Sends what the composer holds with `text`. A shortcut adds its start page, mode and model; while the agent works,
   * the text joins the queue and the start page is not opened.
   */
  const sendMessage = (
    text: string,
    extra: { mode?: PermissionMode; model?: ModelRef; startUrl?: string; shortcut?: true } = {},
  ): void => {
    if (!client) return;
    // `/compact` compacts the conversation now, or at the next turn boundary of a run.
    if (text.trim() === '/compact') {
      if (state.conversationId) client.send({ type: 'compact', conversationId: state.conversationId });
      return;
    }
    if (text.trim() === '/new') return newChat();
    if (active && state.conversationId) {
      client.send({
        type: 'queue',
        conversationId: state.conversationId,
        id: crypto.randomUUID(),
        text,
        attachments: [],
        context: [],
      });
      return;
    }
    if (held !== text && containsCardNumber(text)) {
      setHeld(text);
      return;
    }
    setHeld(null);
    const chosenModel = extra.model && models.some(m => sameModel(m.ref, extra.model)) ? extra.model : model;
    startRun({
      type: 'send',
      tabId: client.tabId,
      conversationId: state.conversationId,
      text,
      attachments: files.map(f => f.ref),
      context: [
        ...pendingTabs.map(p => ({ kind: 'tab' as const, tabId: p.tabId })),
        ...quotes.map(q => ({ kind: 'selection' as const, ...q })),
      ],
      mode: extra.mode ?? mode,
      model: chosenModel,
      reasoning,
      ...(extra.startUrl ? { startUrl: extra.startUrl } : {}),
      ...(extra.shortcut ? { shortcut: true as const } : {}),
      ...(!state.conversationId && temporaryDraft ? { temporary: true as const } : {}),
    });
    setPendingTabs([]);
    setQuotes([]);
    clearFiles();
  };

  const runShortcut = (s: SavedShortcut) => {
    if (!model) return;
    if (!active && s.mode === 'auto' && mode !== 'auto' && !settings.autoNoticeShown) setAutoNotice(true);
    sendMessage(s.text, active ? {} : { mode: s.mode, model: s.model, startUrl: s.startUrl, shortcut: true });
  };

  const onLaunch = (item: LauncherItem) => {
    if (item.kind === 'shortcut') runShortcut(item.shortcut);
    else sendMessage(`/${item.command}`);
  };

  // Which side views this person (or whoever a developer views as) may open; read again when that changes.
  const railKey = commandCenter ? `${commandCenter.user.id}:${commandCenter.viewer?.id ?? ''}` : '';
  useEffect(() => {
    if (!railKey) {
      setRailViews([]);
      return;
    }
    let live = true;
    readPanelViews()
      .then(views => live && setRailViews(views))
      .catch(() => live && setRailViews([]));
    return () => {
      live = false;
    };
  }, [railKey]);
  useEffect(() => {
    if (view !== 'chat' && view !== 'meeting' && !railViews.includes(view)) setView('chat');
  }, [railViews, view]);
  // A card that needs the person (an approval, a question) brings the chat back, so a task never waits out of sight.
  useEffect(() => {
    if (state.prompts.length) setView('chat');
  }, [state.prompts.length]);
  /**
   * Ask on a side view's row (Aaron 2026-11-26): the item's page opens in a new tab beside this one that joins the
   * open chat (a new chat takes it with its first message), its details go with the next message as quoted page text,
   * and the question waits in the message box to send or change. The tab opens behind, so the chat stays in front;
   * the agent brings it forward when it works in it.
   */
  const askFromSide = (ask: SideAsk) => {
    setDraft(ask.text);
    if (ask.details) {
      const quote = { text: ask.details, url: ask.url ?? '', title: ask.title };
      setQuotes(current => [...current.filter(q => q.text !== quote.text), quote]);
    }
    const conversationId = state.conversationId;
    if (ask.url) {
      void chrome.tabs
        .create({ url: ask.url, active: false, ...(client && client.tabId >= 0 ? { openerTabId: client.tabId } : {}) })
        .then(tab => {
          const tabId = tab.id;
          if (tabId === undefined) return;
          if (conversationId) client?.send({ type: 'share-tab', conversationId, tabId });
          else setPendingTabs(tabs => [...tabs, { tabId, title: ask.title }]);
        })
        .catch(error => console.warn('[side] the tab did not open', error));
    }
    setView('chat');
  };
  // Talk it through on a meeting: the voice call opens (or the one going on hears it) with the call's brief.
  const talkFromSide = (call: PanelPrepCall) => {
    setVoiceTopic({
      id: `${call.key}:${Date.now()}`,
      title: `${call.clientName} ${call.kind.toLowerCase()} at ${clock(call.at)}`,
      text: prepDetails(call),
    });
    setVoiceOpen(true);
  };

  if (failure) return <p className="p-4 text-sm text-red-700 dark:text-red-300">{failure}</p>;
  // The quick start above the composer: at most three pinned shortcuts, or the fixed starters.
  const pinned = shortcuts.filter(s => s.pinned).slice(0, 3);
  const starters = pinned.length
    ? pinned.map(s => ({ key: s.id, label: s.description || `/${s.name}`, title: s.text, run: () => runShortcut(s) }))
    : STARTERS.map(s => ({ key: s.label, label: t(s.label), title: t(s.text), run: () => sendMessage(t(s.text)) }));
  const empty = !state.entries.length && !state.streaming;

  return (
    <div className={`flex h-full flex-col${empty && state.loaded ? ' nb-start' : ''}`}>
      {/* The header has no field of its own, so it is part of the panel; a line under it only above a conversation. */}
      <header
        className={`flex items-center gap-1 border-b px-2 py-1.5 ${empty && state.loaded ? 'border-transparent' : 'border-nb-border/60'}`}>
        {/* The mark opens Command Center in a new tab. */}
        <a
          href={commandCenterUrl()}
          target="_blank"
          rel="noreferrer"
          title={t('panel.website')}
          aria-label={t('panel.website')}
          className="ml-1 flex shrink-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent">
          <LogoMark size={20} />
        </a>
        {/* Who is signed in: Chrome's own title bar above shows only the extension's name, so it goes here. While a
            developer views Bash AI as another member, an amber chip says whom, with Exit. */}
        {commandCenter?.viewer ? (
          <span className="ml-1.5 flex min-w-0 flex-1 items-center gap-1 text-xs">
            <span
              className="flex min-w-0 items-baseline gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-800 dark:text-amber-200"
              title={t('viewAs.chipTitle', { viewer: commandCenter.viewer.name })}>
              <span className="truncate font-semibold">{t('viewAs.chip', { name: commandCenter.user.name })}</span>
              {roleLabel(commandCenter.user.role) ? (
                <span className="shrink-0 text-[10px] opacity-80">· {roleLabel(commandCenter.user.role)}</span>
              ) : null}
            </span>
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[11px] font-medium text-amber-800 underline hover:text-amber-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent dark:text-amber-200 dark:hover:text-amber-50"
              onClick={() => void setViewAs(null).catch(error => console.warn('[view-as] exit failed', error))}>
              {t('viewAs.exit')}
            </button>
          </span>
        ) : commandCenter ? (
          <span className="ml-1.5 flex min-w-0 flex-1 items-baseline gap-1.5 text-xs" title={commandCenter.user.email}>
            <span className="truncate font-semibold text-nb-fg">{commandCenter.user.name}</span>
            {roleLabel(commandCenter.user.role) ? (
              <span className="shrink-0 rounded-full bg-nb-accent/15 px-1.5 py-px text-[10px] font-medium text-nb-link">
                {roleLabel(commandCenter.user.role)}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {/* The title is for screen readers only; the header shows the mark and three buttons. */}
        <h1 className="sr-only">{conversation?.title || t('panel.newChat')}</h1>
        <IconButton label={t('panel.newChat')} onClick={() => newChat(confirmNewChat)}>
          <NewChatIcon />
        </IconButton>
        <IconButton
          label={t(temporary ? 'panel.temporary.leave' : 'panel.temporary.start')}
          title={active ? t('panel.temporary.busy') : undefined}
          pressed={temporary}
          disabled={active}
          onClick={toggleTemporary}>
          <TemporaryIcon />
        </IconButton>
        {/* Recent tasks opens once the conversation in this tab stops; other tabs' panels are free. */}
        <IconButton
          label={t('history.title')}
          title={active ? t('history.busy') : undefined}
          disabled={active}
          onClick={() => setHistoryOpen(true)}>
          <HistoryIcon />
        </IconButton>
        {/* Talk: the voice agent, when Command Center offers a realtime voice. */}
        {commandCenter?.extras?.voice.agents.length ? (
          <IconButton
            label={t('voice.title')}
            pressed={voiceOpen}
            onClick={() => {
              setVoiceOpen(open => !open);
              setVoiceTopic(null);
            }}>
            <VoiceIcon />
          </IconButton>
        ) : null}
        {/* Light or dark in one click; Settings → General still offers "System". */}
        <IconButton
          label={t(dark ? 'theme.light' : 'theme.dark')}
          onClick={() => void settingsStorage.set(s => ({ ...s, theme: dark ? 'light' : 'dark' }))}>
          {dark ? <SunIcon /> : <MoonIcon />}
        </IconButton>
        <IconButton label={t('panel.settings')} onClick={() => void chrome.runtime.openOptionsPage()}>
          <SettingsIcon />
        </IconButton>
      </header>
      {/* The voice agent sits at the top, under the header, while it is open. */}
      {voiceOpen && commandCenter ? (
        <VoiceBar
          connection={commandCenter}
          status={state.status}
          lastReply={
            [...state.entries].reverse().flatMap(e => (e.kind === 'assistant' && e.text.trim() ? [e.text] : []))[0] ??
            null
          }
          send={text => sendMessage(text)}
          stopTask={() => {
            if (client && state.conversationId) client.send({ type: 'stop', conversationId: state.conversationId });
          }}
          onClose={() => {
            setVoiceOpen(false);
            setVoiceTopic(null);
          }}
          saveHistory={!temporary}
          topic={voiceTopic}
        />
      ) : null}
      {/* The side views' strip on the right; the chat keeps its place (and its state) while another view shows. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {view === 'meeting' ? (
            <MeetingView onAsk={askFromSide} />
          ) : view !== 'chat' ? (
            <SideView key={`${view}:${railKey}`} view={view} onAsk={askFromSide} onTalk={talkFromSide} />
          ) : null}
          <div className={view === 'chat' ? 'contents' : 'hidden'}>
            {confirmNewChat ? (
              <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <span className="flex-1">{t('panel.newChatRunning')}</span>
                <button type="button" className="underline" onClick={() => newChat(true)}>
                  {t('panel.newChatConfirm')}
                </button>
                <button type="button" className="underline" onClick={() => setConfirmNewChat(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            ) : null}
            {viewAsNotice ? (
              <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <span className="flex-1">{t('viewAs.ended', { reason: viewAsNotice })}</span>
                <button type="button" className="underline" onClick={() => void viewAsNoticeStorage.set(null)}>
                  {t('common.close')}
                </button>
              </div>
            ) : null}
            {temporary ? (
              <div
                role="status"
                className="flex items-center gap-2 border-b border-nb-border/60 bg-nb-surface px-3 py-1 text-[11px] text-nb-muted">
                <TemporaryIcon size={13} />
                <span className="flex-1">{t('panel.temporary.banner')}</span>
              </div>
            ) : null}
            {!empty ? (
              <Transcript
                entries={state.entries}
                streaming={state.streaming}
                live={
                  state.status === 'running' || state.status === 'awaiting_user'
                    ? { startedAt: state.startedAt, waiting: state.status === 'awaiting_user' }
                    : undefined
                }
                actions={
                  state.conversationId && client
                    ? {
                        idle: !active,
                        edit: (entryId, text) =>
                          startRun({ type: 'edit', conversationId: state.conversationId!, entryId, text }),
                        restart: entryId =>
                          startRun({ type: 'restart', conversationId: state.conversationId!, entryId }),
                        retry: () => startRun({ type: 'retry', conversationId: state.conversationId! }),
                      }
                    : undefined
                }
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                  {state.loaded ? <LogoMark size={40} /> : null}
                  {state.loaded ? (
                    <p className="max-w-xs text-[24px] font-normal leading-tight text-nb-fg">{t('panel.empty')}</p>
                  ) : (
                    <p className="text-sm text-nb-muted">{t('panel.loading')}</p>
                  )}
                </div>
                {/* With no model, the no-model card above the composer takes the quick start's place. */}
                {/* The quick start stays hidden while the What's new card shows. */}
                {state.loaded && models.length && !whatsNew ? (
                  <ul className="flex flex-col items-start gap-2 px-3 pb-2" aria-label={t('panel.starters')}>
                    {starters.map(s => (
                      <li key={s.key} className="max-w-full">
                        <button
                          type="button"
                          title={s.title}
                          disabled={!model}
                          className="max-w-full truncate rounded-full border border-nb-border/60 bg-nb-bg px-4 py-2 text-[15px] text-nb-fg shadow-sm transition-colors hover:bg-nb-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent disabled:opacity-40"
                          onClick={s.run}>
                          {s.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
            <TeachVideo
              file={teachFile}
              model={teachModel}
              transcribe={teachTranscribe}
              onClose={() => setTeachFile(null)}
            />
            <HistoryDrawer
              open={historyOpen}
              onOpenChange={setHistoryOpen}
              items={state.history}
              currentId={state.conversationId}
              onQuery={queryHistory}
              onOpen={id => {
                setHistoryOpen(false);
                if (!client) return;
                // A conversation with tabs in this session is shown in its own tab, not copied here (the worker sets that
                // tab's panel back to it); any other is only shown in this panel until the user takes it up.
                const tabs = state.history.find(item => item.id === id)?.tabs ?? [];
                if (tabs.length && !tabs.includes(client.tabId)) showTab(tabs[0]);
                client.send({ type: 'open', conversationId: id, tabId: client.tabId });
              }}
              onRename={(id, title) => client?.send({ type: 'rename', conversationId: id, title })}
              agentTabsOnEnd={settings.agentTabsOnEnd}
              onExport={id => client?.send({ type: 'export', conversationId: id })}
              onDelete={(id, closeAgentTabs, remember) => {
                if (remember)
                  void settingsStorage.set(s => ({ ...s, agentTabsOnEnd: closeAgentTabs ? 'close' : 'keep' }));
                client?.send({ type: 'delete', conversationId: id, closeAgentTabs });
              }}
            />
            <div role="status" aria-live="polite" className="sr-only">
              {t(`status.${state.status}`)}
            </div>
            <Cards
              prompts={state.prompts}
              answer={(promptId, answer) => client?.send({ type: 'answer', promptId, answer })}
            />
            <RunBar
              status={state.status}
              onContinue={() =>
                state.conversationId && startRun({ type: 'continue', conversationId: state.conversationId })
              }
              onResume={() =>
                state.conversationId && startRun({ type: 'resume', conversationId: state.conversationId })
              }
            />
            <QueueList
              items={state.queue}
              onEdit={item => {
                if (!state.conversationId) return;
                client?.send({ type: 'unqueue', conversationId: state.conversationId, id: item.id });
                setDraft(item.text);
              }}
              onDelete={item =>
                state.conversationId &&
                client?.send({ type: 'unqueue', conversationId: state.conversationId, id: item.id })
              }
            />
            <TabBar
              tabs={
                state.conversationId ? state.tabs : pendingTabs.map(p => ({ ...p, url: '', origin: 'user' as const }))
              }
              onUnshare={tabId => {
                if (state.conversationId)
                  client?.send({ type: 'unshare-tab', conversationId: state.conversationId, tabId });
                else setPendingTabs(tabs => tabs.filter(p => p.tabId !== tabId));
              }}
            />
            <Composer
              active={active}
              mode={mode}
              model={model}
              models={models}
              noModel={providersRead && !models.length}
              history={history}
              notice={
                <>
                  {/* The What's new card comes first; the notices below still show under it. The store-rating card is not shown:
                Bash AI is the company's own tool, not in a store. */}
                  {whatsNew ? <WhatsNewCard release={whatsNew} /> : null}
                  {attachError ? (
                    <p className="text-xs text-amber-700 dark:text-amber-300" role="alert">
                      {attachError}
                    </p>
                  ) : autoNotice ? (
                    <AutoNotice onDone={() => setAutoNotice(false)} />
                  ) : providersRead && !models.length ? (
                    <NoticeCard
                      title={t('composer.needModelTitle')}
                      action={{
                        label: t('composer.setUpModel'),
                        // Signs in to Command Center from here; when that fails, Settings shows the reason and the button.
                        run: () =>
                          void signInToCommandCenter().catch(
                            () => void chrome.tabs.create({ url: chrome.runtime.getURL('/options.html#providers') }),
                          ),
                      }}>
                      {t('composer.needModel')}
                    </NoticeCard>
                  ) : held ? (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t('composer.cardWarning')}{' '}
                      <button
                        type="button"
                        className="underline"
                        onClick={() => {
                          const text = held;
                          setHeld(null);
                          if (client && text)
                            startRun({
                              type: 'send',
                              tabId: client.tabId,
                              conversationId: state.conversationId,
                              text,
                              attachments: [],
                              context: [],
                              mode,
                              model,
                              reasoning,
                            });
                        }}>
                        {t('composer.sendAnyway')}
                      </button>
                    </p>
                  ) : state.error ? (
                    <p className="text-xs text-red-700 dark:text-red-300">
                      {state.error in en ? t(state.error as MessageKey) : state.error}
                    </p>
                  ) : null}
                </>
              }
              draft={draft}
              onDraftUsed={() => setDraft('')}
              onSend={sendMessage}
              shortcuts={shortcuts}
              onLaunch={onLaunch}
              files={files}
              quotes={quotes}
              onRemoveQuote={index => setQuotes(current => current.filter((_, i) => i !== index))}
              transcribe={transcribe}
              onOpenSettings={section =>
                void chrome.tabs.create({ url: chrome.runtime.getURL(`/options.html#${section}`) })
              }
              onAttach={list => void attach(list)}
              onScreenshot={() =>
                client?.send({ type: 'screenshot-tab', tabId: client.tabId, conversationId: state.conversationId })
              }
              onTeachVideo={teachModel ? setTeachFile : undefined}
              onRemoveFile={id => {
                setFiles(current => current.filter(f => f.ref.id !== id));
                setAttachError(null);
              }}
              sharedTabs={[client?.tabId ?? -1, ...state.tabs.map(x => x.tabId), ...pendingTabs.map(p => p.tabId)]}
              onShareTab={tab => {
                if (state.conversationId)
                  client?.send({ type: 'share-tab', conversationId: state.conversationId, tabId: tab.tabId });
                else setPendingTabs(tabs => [...tabs, tab]);
              }}
              onStop={() =>
                state.conversationId && client?.send({ type: 'stop', conversationId: state.conversationId })
              }
              onMode={changeMode}
              reasoning={reasoning}
              onModel={next => choose({ model: next, reasoning })}
              onReasoning={next => model && choose({ model, reasoning: next })}
            />
          </div>
        </div>
        <PanelRail views={railViews} current={view} onPick={setView} live={inMeeting} notes={notesLive} />
      </div>
    </div>
  );
}

function IconButton({
  label,
  title,
  disabled,
  pressed,
  onClick,
  children,
}: {
  label: string;
  /** The tooltip, when it says more than the label. */
  title?: string;
  disabled?: boolean;
  /** A toggle that is on (the voice agent open): shown filled. */
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={`flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-nb-surface hover:text-nb-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-nb-muted ${pressed ? 'bg-nb-accent/15 text-nb-accent' : 'text-nb-muted'}`}
      onClick={onClick}>
      {children}
    </button>
  );
}
