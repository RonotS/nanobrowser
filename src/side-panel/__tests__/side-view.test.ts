import { describe, expect, it } from 'vitest';
import { dueLabel, matching, taskSections } from '../side-view';
import type { PanelTask } from '@src/store/command-center';

const task = (over: Partial<PanelTask>): PanelTask => ({
  id: 'x',
  title: 'Task',
  status: 'to do',
  due: null,
  overdue: false,
  priority: null,
  list: null,
  client: null,
  url: null,
  ...over,
});

describe('the side views', () => {
  it('puts overdue tasks first, then the ones with a date, then the ones without', () => {
    const sections = taskSections([
      task({ id: 'a', due: '2026-11-30T00:00:00Z' }),
      task({ id: 'b' }),
      task({ id: 'c', due: '2026-11-20T00:00:00Z', overdue: true }),
    ]);
    expect(sections.overdue.map(t => t.id)).toEqual(['c']);
    expect(sections.upcoming.map(t => t.id)).toEqual(['a']);
    expect(sections.noDue.map(t => t.id)).toEqual(['b']);
  });

  it('writes a due date short, with the year only when it is not this year', () => {
    const now = new Date('2026-11-26T12:00:00Z');
    expect(dueLabel('2026-11-28T17:00:00Z', now)).toBe('Nov 28');
    expect(dueLabel('2027-01-05T17:00:00Z', now)).toBe('Jan 5, 2027');
  });

  it('filters rows by every word, in any order', () => {
    const rows = [
      { name: 'Luxury Bath of Orange County', csm: 'Zach' },
      { name: 'Vivify', csm: 'Zach' },
    ];
    expect(matching(rows, 'orange zach', r => [r.name, r.csm]).map(r => r.name)).toEqual([
      'Luxury Bath of Orange County',
    ]);
    expect(matching(rows, '  ', r => [r.name])).toHaveLength(2);
  });
});
