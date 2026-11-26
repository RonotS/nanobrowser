// The strip down the right of the panel: Chat, and the side views Command Center opens to this person's role
// (Aaron 2026-11-26: "some sort of switcher", then "not on the left but on the right of the Bash AI panel").
// Each is an icon with its name as a tooltip.
import type { ReactNode } from 'react';
import type { PanelView } from '@src/store/command-center';
import { t } from '@src/ui/i18n';
import type { MessageKey } from '@src/ui/i18n';
import { ChatIcon, ListsIcon, ShieldIcon, TasksIcon, TrendDownIcon } from '@src/ui/icons';

export type RailView = 'chat' | PanelView;

const ICONS: Record<RailView, ReactNode> = {
  chat: <ChatIcon size={17} />,
  tasks: <TasksIcon size={17} />,
  lists: <ListsIcon size={17} />,
  quality: <ShieldIcon size={17} />,
  churn: <TrendDownIcon size={17} />,
};

export function PanelRail({
  views,
  current,
  onPick,
}: {
  views: PanelView[];
  current: RailView;
  onPick: (view: RailView) => void;
}) {
  return (
    <nav
      aria-label={t('rail.label')}
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-nb-border/60 py-2">
      {(['chat', ...views] as RailView[]).map(view => {
        const label = t(`rail.${view}` as MessageKey);
        const on = view === current;
        return (
          <button
            key={view}
            type="button"
            aria-label={label}
            aria-pressed={on}
            title={label}
            onClick={() => onPick(view)}
            className={`flex size-8 items-center justify-center rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent ${
              on ? 'bg-nb-accent/15 text-nb-accent' : 'text-nb-muted hover:bg-nb-surface hover:text-nb-fg'
            }`}>
            {ICONS[view]}
          </button>
        );
      })}
    </nav>
  );
}
