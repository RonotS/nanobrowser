import { describe, expect, it } from 'vitest';
import { briefMarkdown, dueLabel, matching, prepDetails, prepSections, taskDetails, taskSections } from '../side-view';
import type { PanelPrepCall, PanelTask } from '@src/store/command-center';

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

// Aaron 2026-11-26: Ask opens the item in a new tab of the open chat and makes it the chat's topic.
describe('what Ask hands the chat', () => {
  it("gives a task's status, due date, list and link", () => {
    const text = taskDetails(
      task({ title: 'Team payments update', status: 'speak about later', due: '2026-11-16T17:00:00Z', overdue: true, list: 'Updates Needed', url: 'https://app.clickup.com/t/86akg7jpa' }),
    );
    expect(text).toBe(
      'ClickUp task: Team payments update\nStatus: speak about later\nDue: Nov 16 (overdue)\nList: Updates Needed\nLink: https://app.clickup.com/t/86akg7jpa',
    );
  });
});

describe('Meeting prep', () => {
  const call = (over: Partial<PanelPrepCall>): PanelPrepCall => ({
    key: 'c1|2026-11-26T15:00:00.000Z',
    clientId: 'c1',
    clientName: 'Install America',
    at: '2026-11-26T15:00:00.000Z',
    endAt: '2026-11-26T15:30:00.000Z',
    day: 'today',
    inProgress: false,
    kind: 'Check-up',
    title: 'Install America weekly',
    meetLink: 'https://meet.google.com/abc',
    headline: 'Spend is still $0.',
    talkingPoints: ['Confirm the launch date'],
    brief: 'Spend is still $0.\n\n**Talking points**\n• Confirm the launch date',
    builtAt: '2026-11-26T12:37:00.000Z',
    stale: false,
    clientUrl: 'https://cc.example/clients/c1',
    recordingUrl: null,
    ...over,
  });

  it('splits the calls by day, in time order', () => {
    const sections = prepSections([
      call({ key: 'b', clientName: 'Melby', at: '2026-11-26T19:00:00.000Z' }),
      call({ key: 'c', clientName: 'HutchCo', day: 'tomorrow', at: '2026-11-27T15:00:00.000Z' }),
      call({ key: 'a' }),
    ]);
    expect(sections.today.map(c => c.clientName)).toEqual(['Install America', 'Melby']);
    expect(sections.tomorrow.map(c => c.clientName)).toEqual(['HutchCo']);
  });

  it("hands the chat which call it is and the whole brief, and shows the brief's bullets as a list", () => {
    const text = prepDetails(call({}));
    expect(text).toMatch(/^Client call: Install America, Check-up, today at /);
    expect(text).toContain('Meeting link: https://meet.google.com/abc');
    expect(text).toContain('Client in Command Center: https://cc.example/clients/c1');
    expect(text).toContain('**Talking points**\n• Confirm the launch date');
    expect(prepDetails(call({ brief: null, builtAt: null }))).toContain('No brief built yet');
    expect(briefMarkdown('**Talking points**\n• One\n• Two')).toBe('**Talking points**\n- One\n- Two');
  });
});
