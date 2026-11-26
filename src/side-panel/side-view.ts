// The side views' pure parts (tested): sorting tasks into sections, the due label, filtering rows by words.
import type { PanelTask } from '@src/store/command-center';

export interface TaskSections {
  overdue: PanelTask[];
  upcoming: PanelTask[];
  noDue: PanelTask[];
}

/** Overdue first, then the rest by due date, then the ones with no due date. */
export function taskSections(tasks: PanelTask[]): TaskSections {
  return {
    overdue: tasks.filter(t => t.due && t.overdue),
    upcoming: tasks.filter(t => t.due && !t.overdue),
    noDue: tasks.filter(t => !t.due),
  };
}

/** "Nov 28", or "Nov 28, 2027" when it is not this year. */
export function dueLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** The rows whose words hold every word of the query (any order, any case). */
export function matching<T>(rows: T[], query: string, words: (row: T) => Array<string | null | undefined>): T[] {
  const parts = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return rows;
  return rows.filter(row => {
    const text = words(row).filter(Boolean).join(' ').toLowerCase();
    return parts.every(p => text.includes(p));
  });
}
