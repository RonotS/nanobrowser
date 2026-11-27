import { describe, expect, it } from 'vitest';
import {
  addSoundLine,
  applyFeed,
  fitsTurn,
  foldTurn,
  keepTurn,
  meetTitle,
  notesForCommandCenter,
  notesQuote,
  notesText,
  speakerBlocks,
  turnsToPolish,
} from '../meeting-notes';
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

describe("speaker turns, transcribed again from the call's sound", () => {
  const feed = (id: string, speaker: string, text: string, start: number, end: number, final = true) => ({
    id,
    speaker,
    text,
    final,
    start,
    end,
  });
  const lines = applyFeed(
    [],
    [
      feed('1', 'Aaron', 'I noticed that while', 1000, 3000),
      feed('2', 'Aaron', 'Function.', 4000, 5000),
      feed('3', 'Zach', 'got it', 9000, 9500),
      feed('4', 'Zach', 'and the', 10_000, 11_000, false),
    ],
    at,
  );

  it("a turn is ready when someone else speaks or after a 4 s pause, and only once it's final", () => {
    expect(turnsToPolish(lines, 12_000)).toEqual([
      { ids: ['f:1', 'f:2'], speaker: 'Aaron', start: 1000, end: 5000, text: 'I noticed that while Function.' },
    ]);
    const done = applyFeed(lines, [feed('4', 'Zach', 'and the budget', 10_000, 11_000)], at);
    expect(turnsToPolish(done, 13_000).map(t => t.ids)).toEqual([['f:1', 'f:2']]);
    expect(turnsToPolish(done, 16_000).map(t => t.ids)).toEqual([
      ['f:1', 'f:2'],
      ['f:3', 'f:4'],
    ]);
    // A turn already being transcribed isn't taken twice.
    expect(turnsToPolish(lines, 12_000, new Set(['f:1', 'f:2']))).toEqual([]);
  });

  it("OpenAI's words replace the turn as one line; Meet's late updates for it stay out", () => {
    const [turn] = turnsToPolish(lines, 12_000);
    const folded = foldTurn(
      lines,
      turn,
      'I noticed that while I am in the call still. I need an indicator on the call function.',
    );
    expect(folded.map(l => [l.id, l.speaker, l.polished ?? false])).toEqual([
      ['t:f:1', 'Aaron', true],
      ['f:3', 'Zach', false],
      ['f:4', 'Zach', false],
    ]);
    const late = applyFeed(folded, [feed('2', 'Aaron', 'Function. Yes.', 4000, 5200)], at, new Set(turn.ids));
    expect(late.some(l => l.id === 'f:2')).toBe(false);
    expect(
      keepTurn(lines, turn)
        .filter(l => l.polished)
        .map(l => l.id),
    ).toEqual(['f:1', 'f:2']);
  });

  it("OpenAI's words must fit what Meet heard: shared words, or a similar length", () => {
    expect(fitsTurn('Function.', 'I need an indicator on the call function')).toBe(true);
    expect(fitsTurn('My favorite some issues', 'Maybe a red dot flashing')).toBe(true);
    expect(fitsTurn('Nice.', 'Thank you.')).toBe(false);
    expect(fitsTurn('we should move the call to three tomorrow', '')).toBe(false);
    expect(fitsTurn('we should move the call to three tomorrow', 'Thank you.')).toBe(false);
  });

  it("one block per speaker's turn on screen", () => {
    expect(speakerBlocks(lines).map(b => [b.speaker, b.lines.length])).toEqual([
      ['Aaron', 2],
      ['Zach', 2],
    ]);
  });
});
