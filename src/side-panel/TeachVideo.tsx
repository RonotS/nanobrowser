// "Teach from a video": over the whole panel, a screen recording becomes an SOP draft. The panel reads the stills and
// the narration (teach-video.ts), Command Center transcribes the narration, Claude writes the steps (src/llm/teach.ts),
// and the person checks the draft before anything is saved. Saving makes a Google Doc in the SOPs folder's drafts.
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { draftTitle, withTitle, writeSopDraft } from '@src/llm/teach';
import type { ChatModel } from '@src/llm/providers';
import { saveSopDraft } from '@src/store/command-center';
import type { SavedSopDraft } from '@src/store/command-center';
import { t } from '@src/ui/i18n';
import type { MessageKey } from '@src/ui/i18n';
import { CloseIcon, SpinnerIcon } from '@src/ui/icons';
import { Markdown } from './Markdown';
import { durationProblem, isVideoFile, openVideo, readNarration, readStills } from './teach-video';

type Phase =
  | { kind: 'opening' }
  | { kind: 'reading'; share: number; stills: number }
  | { kind: 'listening' }
  | { kind: 'transcribing'; part: number; parts: number }
  | { kind: 'writing'; stills: number }
  | { kind: 'preview' }
  | { kind: 'failed'; message: string };

const btn = 'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50';
const primary = `${btn} bg-nb-accent text-white shadow-sm hover:bg-nb-accent-strong`;
const secondary = `${btn} border border-nb-border bg-nb-bg hover:bg-nb-surface`;

const PROBLEMS: Record<string, MessageKey> = {
  'not-video': 'teach.notVideo',
  'too-long': 'teach.tooLong',
  unreadable: 'teach.unreadable',
};

const reason = (error: unknown) => String((error as Error)?.message ?? error);

export function TeachVideo({
  file,
  model,
  transcribe,
  onClose,
}: {
  /** The video picked; null closes the view. */
  file: File | null;
  /** Claude through Command Center. */
  model: ChatModel | null;
  /** Command Center's transcription, or null when it offers none (the steps then come from the stills alone). */
  transcribe: ((audio: Uint8Array) => Promise<string>) | null;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' });
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [durationSec, setDurationSec] = useState(0);
  const [narrationNote, setNarrationNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedSopDraft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const latest = useRef({ model, transcribe });
  latest.current = { model, transcribe };

  useEffect(() => {
    if (!file) return;
    const abort = new AbortController();
    const { signal } = abort;
    setPhase({ kind: 'opening' });
    setTitle('');
    setMarkdown('');
    setNarrationNote(null);
    setEditing(false);
    setSaved(null);
    setSaveError(null);
    void (async () => {
      const chat = latest.current.model;
      if (!chat) throw new Error(t('teach.noModel'));
      if (!isVideoFile(file.name, file.type)) throw new Error(t('teach.notVideo'));
      const { video, url } = await openVideo(file, signal).catch(() => {
        throw new Error(t('teach.unreadable'));
      });
      try {
        const problem = durationProblem(video.duration);
        if (problem) throw new Error(t(PROBLEMS[problem]));
        setDurationSec(video.duration);
        const stills = await readStills(
          video,
          (share, count) => setPhase({ kind: 'reading', share, stills: count }),
          signal,
        );
        if (!stills.length) throw new Error(t('teach.unreadable'));

        // The narration: transcribed piece by piece. A piece that fails is left out and said, never the whole video.
        setPhase({ kind: 'listening' });
        const pieces = await readNarration(file);
        const send = latest.current.transcribe;
        const words: string[] = [];
        let failure: string | null = null;
        if (pieces.length && !send) failure = t('teach.noTranscription');
        for (const [i, piece] of (send ? pieces : []).entries()) {
          if (signal.aborted) return;
          setPhase({ kind: 'transcribing', part: i + 1, parts: pieces.length });
          try {
            words.push(await send!(piece));
          } catch (error) {
            failure = reason(error);
          }
        }
        if (failure) setNarrationNote(failure);

        setPhase({ kind: 'writing', stills: stills.length });
        const draft = await writeSopDraft(
          chat,
          { sourceName: file.name, durationSec: video.duration, stills, transcript: words.join('\n').trim() },
          { abortSignal: signal },
        );
        if (signal.aborted) return;
        setTitle(draftTitle(draft, file.name));
        setMarkdown(draft);
        setPhase({ kind: 'preview' });
      } finally {
        URL.revokeObjectURL(url);
        video.removeAttribute('src');
        video.load();
      }
    })().catch(error => {
      if (signal.aborted || (error as Error)?.name === 'AbortError') return;
      setPhase({ kind: 'failed', message: reason(error) });
    });
    return () => abort.abort();
  }, [file]);

  const working = phase.kind !== 'preview' && phase.kind !== 'failed';
  const unsaved = phase.kind === 'preview' && !saved;

  const save = async () => {
    if (!file || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      setSaved(
        await saveSopDraft({
          title: title.trim() || draftTitle(markdown, file.name),
          markdown: withTitle(markdown, title),
          sourceName: file.name,
          durationSec: Math.round(durationSec),
        }),
      );
    } catch (error) {
      // The draft stays on screen, so it can be saved again or copied.
      setSaveError(reason(error));
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(withTitle(markdown, title)).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog.Root open={!!file} onOpenChange={open => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Content
          // An unsaved draft is not dropped by Esc or a click outside: Discard does that.
          onEscapeKeyDown={e => (unsaved ? e.preventDefault() : undefined)}
          onPointerDownOutside={e => (unsaved ? e.preventDefault() : undefined)}
          className="fixed inset-0 flex flex-col gap-3 bg-nb-canvas px-4 pb-3 pt-4 focus:outline-none"
          data-role="teach-video">
          <div className="flex items-center gap-2 pl-1">
            <Dialog.Title className="flex-1 text-xl font-semibold tracking-tight">{t('teach.heading')}</Dialog.Title>
            {!unsaved ? (
              <Dialog.Close
                className="flex size-8 items-center justify-center rounded-lg text-nb-muted hover:bg-nb-surface hover:text-nb-fg"
                aria-label={t('common.close')}>
                <CloseIcon size={18} />
              </Dialog.Close>
            ) : null}
          </div>
          <Dialog.Description className="truncate pl-1 text-xs text-nb-muted">{file?.name}</Dialog.Description>

          {working ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center" aria-live="polite">
              <SpinnerIcon size={22} className="animate-spin text-nb-muted" />
              <p className="text-sm">{progressText(phase)}</p>
              {phase.kind === 'reading' ? (
                <div className="h-1 w-48 overflow-hidden rounded-full bg-nb-surface">
                  <div
                    className="h-full bg-nb-accent transition-all"
                    style={{ width: `${Math.round(phase.share * 100)}%` }}
                  />
                </div>
              ) : null}
              <button type="button" className={secondary} onClick={onClose}>
                {t('common.cancel')}
              </button>
            </div>
          ) : null}

          {phase.kind === 'failed' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <p className="max-w-xs text-sm text-red-700 dark:text-red-300" role="alert">
                {phase.message}
              </p>
              <button type="button" className={secondary} onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          ) : null}

          {phase.kind === 'preview' ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-nb-muted">
                {t('teach.title')}
                <input
                  value={title}
                  disabled={!!saved}
                  onChange={e => setTitle(e.target.value)}
                  className="rounded-lg border border-nb-border bg-nb-bg px-2 py-1.5 text-sm text-nb-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-nb-accent"
                />
              </label>
              {narrationNote ? (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                  {t('teach.narrationFailed', { reason: narrationNote })}
                </p>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-nb-border bg-nb-bg p-3 text-sm">
                {editing ? (
                  <textarea
                    value={markdown}
                    onChange={e => setMarkdown(e.target.value)}
                    aria-label={t('teach.edit')}
                    className="size-full min-h-[60vh] resize-none bg-transparent font-mono text-xs focus:outline-none"
                  />
                ) : (
                  <Markdown text={withTitle(markdown, title)} />
                )}
              </div>
              {saved ? (
                <p className="text-xs" role="status">
                  {t('teach.saved', { folder: saved.folder })}{' '}
                  <a href={saved.link} target="_blank" rel="noreferrer" className="text-nb-link underline">
                    {t('teach.open')}
                  </a>
                </p>
              ) : null}
              {saveError ? (
                <p className="text-xs text-red-700 dark:text-red-300" role="alert">
                  {t('teach.saveFailed', { reason: saveError })}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                {saved ? (
                  <button type="button" className={primary} onClick={onClose}>
                    {t('teach.done')}
                  </button>
                ) : (
                  <>
                    <button type="button" className={primary} disabled={saving || !markdown.trim()} onClick={save}>
                      {saving ? t('teach.saving') : t('teach.save')}
                    </button>
                    <button type="button" className={secondary} disabled={saving} onClick={() => setEditing(e => !e)}>
                      {editing ? t('teach.preview') : t('teach.edit')}
                    </button>
                    {saveError ? (
                      <button type="button" className={secondary} onClick={copy}>
                        {copied ? t('teach.copied') : t('teach.copy')}
                      </button>
                    ) : null}
                    <span className="flex-1" />
                    <button type="button" className={secondary} disabled={saving} onClick={onClose}>
                      {t('teach.discard')}
                    </button>
                  </>
                )}
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function progressText(phase: Phase): string {
  switch (phase.kind) {
    case 'reading':
      return t('teach.reading', { stills: phase.stills });
    case 'listening':
      return t('teach.listening');
    case 'transcribing':
      return t('teach.transcribing', { part: phase.part, parts: phase.parts });
    case 'writing':
      return t('teach.writing', { stills: phase.stills });
    default:
      return t('teach.opening');
  }
}
