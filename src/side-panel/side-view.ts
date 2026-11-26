// The side views' pure parts (tested): sorting tasks into sections, the due label, filtering rows by words, what Ask
// hands the chat, and Meeting prep's calls by day.
import type { PanelPrepCall, PanelTask } from '@src/store/command-center';

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

/**
 * What Ask hands the chat (Aaron 2026-11-26: the item opens in a new tab and becomes the chat's topic, in the chat
 * that is open rather than a fresh one): the question for the message box, the page to open in a tab that joins the
 * chat, and the item's details, which go with the message as quoted page text (data, not instructions).
 */
export interface SideAsk {
  text: string;
  title: string;
  url: string | null;
  details: string | null;
}

const lines = (rows: Array<string | null | undefined | false>) => rows.filter(Boolean).join('\n');

/** A time in the person's own clock, "10:30 AM". */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function taskDetails(task: PanelTask): string {
  return lines([
    `ClickUp task: ${task.title}`,
    `Status: ${task.status || 'none'}`,
    task.due ? `Due: ${dueLabel(task.due)}${task.overdue ? ' (overdue)' : ''}` : 'Due: no due date',
    task.priority && `Priority: ${task.priority}`,
    task.list && `List: ${task.list}`,
    task.client && `Client: ${task.client}`,
    task.url && `Link: ${task.url}`,
  ]);
}

/** A call's brief as the chat gets it with Ask: which call, then the whole brief Command Center wrote. */
export function prepDetails(call: PanelPrepCall): string {
  return lines([
    `Client call: ${call.clientName}, ${call.kind}, ${call.day} at ${clock(call.at)}${call.inProgress ? ' (in progress)' : ''}`,
    `Calendar: ${call.title}`,
    call.owners.length > 0 && `With: ${call.owners.join(', ')}`,
    call.meetLink && `Meeting link: ${call.meetLink}`,
    `Client in Command Center: ${call.clientUrl}`,
    call.builtAt ? `Brief built: ${new Date(call.builtAt).toLocaleString('en-US')}` : 'No brief built yet for this client.',
    call.brief && `\n${call.brief}`,
  ]);
}

/** Meeting prep's calls by day, in order; a call in progress leads today. */
export function prepSections(calls: PanelPrepCall[]): { today: PanelPrepCall[]; tomorrow: PanelPrepCall[] } {
  const sorted = [...calls].sort((a, b) => a.at.localeCompare(b.at));
  return { today: sorted.filter(c => c.day === 'today'), tomorrow: sorted.filter(c => c.day === 'tomorrow') };
}

/** The brief's bullets as Markdown list items (Command Center writes "• "). */
export function briefMarkdown(brief: string): string {
  return brief.replace(/^• /gm, '- ');
}
