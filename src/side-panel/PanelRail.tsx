// The strip down the right of the panel: Chat, and the side views Command Center opens to this person's role
// (Aaron 2026-11-26: "some sort of switcher", then "not on the left but on the right of the Bash AI panel").
// Each is an icon with its name as a tooltip.
import type { ReactNode } from 'react';
import type { PanelView } from '@src/store/command-center';
import { t } from '@src/ui/i18n';
import type { MessageKey } from '@src/ui/i18n';
import { CalendarIcon, ChatIcon, ListsIcon, PhoneIcon, ShieldIcon, TasksIcon, TrendDownIcon } from '@src/ui/icons';

/** 'meeting' is the panel's own view (Bash AI in a Google Meet), not one of Command Center's side views. */
export type RailView = 'chat' | PanelView | 'meeting';

const ICONS: Record<RailView, ReactNode> = {
  chat: <ChatIcon size={17} />,
  tasks: <TasksIcon size={17} />,
  prep: <CalendarIcon size={17} />,
  lists: <ListsIcon size={17} />,
  quality: <ShieldIcon size={17} />,
  churn: <TrendDownIcon size={17} />,
  meeting: <PhoneIcon size={17} />,
};

export function PanelRail({
  views,
  current,
  onPick,
  live = false,
  notes = null,
}: {
  views: PanelView[];
  current: RailView;
  onPick: (view: RailView) => void;
  /** Bash AI is in a meeting: a dot on the Meeting icon. */
  live?: boolean;
  /**
   * Notes are being taken (and the call recorded) in a Meet tab: a flashing red dot on the Meeting icon, seen from any
   * view (Aaron 2026-11-27: chatting doesn't stop the notes, so the panel should show they go on).
   */
  notes?: 'recording' | 'notes' | null;
}) {
  return (
    <nav
      aria-label={t('rail.label')}
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-nb-border/60 py-2">
      {(['chat', ...views, 'meeting'] as RailView[]).map(view => {
        const label =
          view === 'meeting' && notes
            ? t(notes === 'recording' ? 'rail.meetingRecording' : 'rail.meetingNotes')
            : t(`rail.${view}` as MessageKey);
        const on = view === current;
        return (
          <button
            key={view}
            type="button"
            aria-label={label}
            aria-pressed={on}
            title={label}
            onClick={() => onPick(view)}
            className={`relative flex size-8 items-center justify-center rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent ${
              on ? 'bg-nb-accent/15 text-nb-accent' : 'text-nb-muted hover:bg-nb-surface hover:text-nb-fg'
            }`}>
            {ICONS[view]}
            {view === 'meeting' && notes ? (
              <span aria-hidden className="absolute right-1 top-1 flex size-2">
                <span className="absolute inline-flex size-full rounded-full bg-red-500 opacity-75 motion-safe:animate-ping" />
                <span className="relative inline-flex size-2 rounded-full bg-red-500" />
              </span>
            ) : view === 'meeting' && live ? (
              <span aria-hidden className="absolute right-1 top-1 size-2 rounded-full bg-green-500" />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
