// Temporary chats (src/extension/temporary.ts): kept out of Recent tasks and Command Center, and deleted once nobody
// shows them and nothing runs in them.
import { describe, expect, it } from 'vitest';
import { MIN_AGE_MS, inHistory, savedToCommandCenter, temporaryToDrop } from '../temporary';

const NOW = Date.parse('2026-11-25T20:00:00Z');
const old = new Date(NOW - 60_000).toISOString();
const chat = (id: string, temporary?: boolean, createdAt = old) => ({
  id,
  createdAt,
  ...(temporary ? { temporary } : {}),
});

describe('temporary chats', () => {
  it('are never listed in Recent tasks', () => {
    expect(inHistory([chat('a'), chat('t', true), chat('b')]).map(c => c.id)).toEqual(['a', 'b']);
  });

  it('are never sent to Command Center, so they are in neither its history nor its search', () => {
    expect(savedToCommandCenter(chat('a'))).toBe(true);
    expect(savedToCommandCenter(chat('t', true))).toBe(false);
  });

  it('are deleted once no panel shows them and no run works in them', () => {
    const all = [chat('a'), chat('shown', true), chat('running', true), chat('left', true)];
    expect(temporaryToDrop(all, new Set(['shown', 'a']), new Set(['running']), NOW)).toEqual(['left']);
    // A normal conversation is never dropped, shown or not.
    expect(temporaryToDrop([chat('a')], new Set(), new Set(), NOW)).toEqual([]);
  });

  it('are kept while their first message may still be on the way to the panel', () => {
    const young = chat('new', true, new Date(NOW - MIN_AGE_MS + 1_000).toISOString());
    expect(temporaryToDrop([young], new Set(), new Set(), NOW)).toEqual([]);
    expect(temporaryToDrop([young], new Set(), new Set(), NOW + MIN_AGE_MS)).toEqual(['new']);
  });
});
