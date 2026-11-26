// Temporary chats (Aaron 2026-11-25: "for various private uses … users would not have to worry about deleting
// historical conversations"). A temporary conversation lives only while someone looks at it: it is never listed in
// Recent tasks, never sent to Command Center (so it is in neither its history nor its search index), and it is deleted
// with its messages, files and run record once no panel shows it and nothing runs in it. The worker checks after a
// panel moves to another conversation, after a panel closes (with a short grace, so a panel that reloads keeps it),
// after a run ends, and once a little after each worker start, so a crashed panel leaves nothing behind.
import type { Conversation } from '@src/store/types';

/** How long a closed panel's temporary chat waits before it is deleted: a panel that reloads comes back within it. */
export const CLOSED_PANEL_GRACE_MS = 5_000;
/** How long after a worker start the leftover sweep waits: the open panels connect again first. */
export const START_SWEEP_DELAY_MS = 30_000;

/** The conversations Recent tasks lists: never a temporary one. */
export function inHistory<T extends Pick<Conversation, 'temporary'>>(conversations: T[]): T[] {
  return conversations.filter(c => !c.temporary);
}

/** Whether a conversation goes to Command Center's history (and so its search index): a temporary one never does. */
export function savedToCommandCenter(conversation: Pick<Conversation, 'temporary'>): boolean {
  return !conversation.temporary;
}

/** A conversation this young is never deleted: its first message may still be on the way to the panel that sent it. */
export const MIN_AGE_MS = 10_000;

/** The temporary conversations to delete now: those no panel shows and no run works in. */
export function temporaryToDrop(
  conversations: Array<Pick<Conversation, 'id' | 'temporary' | 'createdAt'>>,
  shown: ReadonlySet<string>,
  running: ReadonlySet<string>,
  now = Date.now(),
): string[] {
  return conversations
    .filter(c => c.temporary && !shown.has(c.id) && !running.has(c.id))
    .filter(c => !(now - Date.parse(c.createdAt) < MIN_AGE_MS))
    .map(c => c.id);
}
