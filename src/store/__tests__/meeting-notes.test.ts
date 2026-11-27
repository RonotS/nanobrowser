import { describe, expect, it } from 'vitest';
import { addSoundLine, applyFeed, meetTitle, notesForCommandCenter, notesQuote, notesText } from '../meeting-notes';
import type { NotesSession } from '../meeting-notes';

const at = new Date('2026-11-27T13:10:00Z');

describe('the notes transcript', () => {
  it('an utterance keeps one line that grows until final; a new utterance is a new line', () => {
    let lines = applyFeed([], [{ id: '1', speaker: 'Zach', text: 'so the', final: false }], at);
    lines = applyFeed(lines, [{ id: '1', speaker: 'Zach', text: 'so the call moved', final: true }], at);
    lines = applyFeed(lines, [{ id: '2', speaker: 'Aaron', text: 'got it', final: false }], at);
    expect(lines.map(l => [l.id, l.speaker, l.text, l.done])).toEqual([
      ['f:1', 'Zach', 'so the call moved', true],
      ['f:2', 'Aaron', 'got it', false],
    ]);
  });

  it("a line from the call's sound has no speaker and goes in time order", () => {
    const lines = addSoundLine(
      applyFeed([], [{ id: '1', speaker: 'Zach', text: 'later', final: true }], new Date('2026-11-27T13:20:00Z')),
      '2026-11-27T13:15:00.000Z',
      ' earlier words ',
    );
    expect(lines.map(l => [l.speaker, l.text])).toEqual([
      ['', 'earlier words'],
      ['Zach', 'later'],
    ]);
    expect(notesText(lines)).toContain('Meeting: earlier words');
  });

  it('the named transcript for a question, and the meeting title from the tab', () => {
    const lines = applyFeed([], [{ id: '1', speaker: 'Zach Kostic', text: 'Bash AI, what is next?', final: true }], at);
    expect(notesText(lines)).toBe('[7:10 AM] Zach Kostic: Bash AI, what is next?');
    expect(notesQuote({ title: 'Tech sync', startedAt: at.toISOString() }, lines)).toContain('with who said each line');
    expect(meetTitle('Meet - hew-arks-weu', 'https://meet.google.com/hew-arks-weu')).toBe('hew-arks-weu');
    expect(meetTitle('Weekly sync - Google Meet', 'x')).toBe('Weekly sync');
  });

  it('saved to Command Center as a conversation it accepts: id, summary first, lines with speakers', () => {
    const session: NotesSession = {
      key: 'nabc123',
      meetUrl: 'https://meet.google.com/hew-arks-weu',
      title: 'Tech sync',
      tabId: 5,
      startedAt: at.toISOString(),
      lines: applyFeed([], [{ id: '1', speaker: 'Zach', text: 'Ship it Friday.', final: true }], at),
      notice: 'posted',
      summary: '## Summary\nShip Friday.',
    };
    const chat = notesForCommandCenter(session, new Date('2026-11-27T13:40:00Z'));
    expect(chat.externalId).toMatch(/^[\w-]{1,100}$/);
    expect(chat.title).toBe('Meeting notes: Tech sync (Nov 27, 2026)');
    expect(chat.transcript).toEqual([
      expect.objectContaining({ kind: 'notice' }),
      { kind: 'assistant', text: '## Summary\nShip Friday.', at: '2026-11-27T13:40:00.000Z' },
      { kind: 'user', text: 'Zach: Ship it Friday.', at: at.toISOString() },
    ]);
  });

  it('a long meeting fits the 1,500 entries Command Center keeps', () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      id: String(i),
      speaker: i % 2 ? 'Zach' : 'Aaron',
      text: `line ${i}`,
      final: true,
    }));
    const lines = applyFeed([], rows, at);
    const chat = notesForCommandCenter(
      { key: 'k', meetUrl: 'u', title: 't', tabId: 1, startedAt: at.toISOString(), lines, notice: 'posted' },
      at,
    );
    expect(chat.transcript.length).toBeLessThanOrEqual(1500);
    expect(JSON.stringify(chat.transcript)).toContain('line 2999');
    expect(JSON.stringify(chat.transcript)).toContain('line 0');
  });
});

describe('the saved notes with a recording', () => {
  it('carry the Drive link', () => {
    const chat = notesForCommandCenter(
      {
        key: 'k',
        meetUrl: 'https://meet.google.com/x',
        title: 't',
        tabId: 1,
        startedAt: at.toISOString(),
        lines: [],
        notice: 'posted',
        recording: { state: 'saved', url: 'https://drive.google.com/file/d/abc/view' },
      },
      at,
    );
    expect(chat.transcript[1]).toEqual({
      kind: 'notice',
      text: 'Recording (video + audio) in Google Drive: https://drive.google.com/file/d/abc/view',
      at: at.toISOString(),
    });
  });
});
