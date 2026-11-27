import { describe, expect, it } from 'vitest';
import { CAPTION_NOISE, parseCaption } from '../../side-panel/meet-notes-page';
import { applyRows, meetTitle, notesForCommandCenter, notesQuote, notesText } from '../meeting-notes';
import type { NotesSession } from '../meeting-notes';

const at = new Date('2026-11-27T13:10:00Z');

describe("reading Meet's captions", () => {
  it('a caption block is the speaker, then what they said; Meet’s own words are dropped', () => {
    expect(parseCaption('Zach Kostic\nso the Install America call moved\nto three')).toEqual({
      speaker: 'Zach Kostic',
      text: 'so the Install America call moved to three',
    });
    expect(parseCaption('just words')).toEqual({ speaker: '', text: 'just words' });
    expect(parseCaption('arrow_downward Jump to bottom')).toBeNull();
    expect(CAPTION_NOISE.test('Live captions are on')).toBe(true);
  });
});

describe('the notes transcript', () => {
  it('a block that grows updates its line; a block Meet drops is done; a new block is a new line', () => {
    let lines = applyRows([], [{ id: 'k:1', speaker: 'Zach', text: 'so the' }], at);
    lines = applyRows(lines, [{ id: 'k:1', speaker: 'Zach', text: 'so the call moved' }], at);
    expect(lines).toEqual([
      { id: 'k:1', speaker: 'Zach', text: 'so the call moved', at: at.toISOString(), done: false },
    ]);
    lines = applyRows(lines, [{ id: 'k:2', speaker: 'Aaron', text: 'got it' }], at);
    expect(lines.map(l => [l.speaker, l.text, l.done])).toEqual([
      ['Zach', 'so the call moved', true],
      ['Aaron', 'got it', false],
    ]);
  });

  it('Meet redrawing a block (new element, same words) extends the line instead of repeating it', () => {
    let lines = applyRows([], [{ id: 'k:1', speaker: 'Zach', text: 'the call moved' }], at);
    lines = applyRows(lines, [{ id: 'k:9', speaker: 'Zach', text: 'the call moved to three' }], at);
    expect(lines.map(l => [l.id, l.text])).toEqual([['k:9', 'the call moved to three']]);
  });

  it('the named transcript for a question, and the meeting title from the tab', () => {
    const lines = applyRows([], [{ id: 'k:1', speaker: 'Zach Kostic', text: 'Bash AI, what is next?' }], at);
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
      lines: applyRows([], [{ id: 'k:1', speaker: 'Zach', text: 'Ship it Friday.' }], at),
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
      id: `k:${i}`,
      speaker: i % 2 ? 'Zach' : 'Aaron',
      text: `line ${i}`,
    }));
    let lines: ReturnType<typeof applyRows> = [];
    for (const row of rows) lines = applyRows(lines, [row], at);
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
