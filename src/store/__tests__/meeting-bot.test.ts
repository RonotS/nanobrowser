import { describe, expect, it, vi } from 'vitest';
import {
  MeetingGoneError,
  PANEL_LINES,
  QUOTE_LIMIT,
  leaveMeeting,
  lineId,
  looksLikeDialIn,
  meetCallUrl,
  mergeLines,
  pendingLive,
  readMeeting,
  transcriptQuote,
} from '../meeting-bot';
import type { MeetingLine } from '../meeting-bot';

const meeting = { botUrl: 'https://bot.example.com/', sessionId: 'sess-1234', grant: 'mbg_x.y' };
const line = (n: number, who: MeetingLine['who'], text: string): MeetingLine => ({
  n,
  at: '2026-11-27T05:42:00Z',
  who,
  text,
});

describe('the Meet tab', () => {
  it('is a call only on a meeting code, not on Meet home or other pages', () => {
    expect(meetCallUrl('https://meet.google.com/uty-adfc-yff?authuser=0')).toBe('https://meet.google.com/uty-adfc-yff');
    expect(meetCallUrl('https://meet.google.com/UTY-ADFC-YFF')).toBe('https://meet.google.com/uty-adfc-yff');
    expect(meetCallUrl('https://meet.google.com/')).toBeNull();
    expect(meetCallUrl('https://meet.google.com/landing')).toBeNull();
    expect(meetCallUrl('https://evil.example.com/meet.google.com/uty-adfc-yff')).toBeNull();
    expect(meetCallUrl(undefined)).toBeNull();
  });

  it('knows a pasted Join by phone line', () => {
    expect(looksLikeDialIn('(US) +1 252-491-3094 PIN: 695 650 138#')).toBe(true);
    expect(looksLikeDialIn('+1 252-491-3094')).toBe(false);
    expect(looksLikeDialIn('pin')).toBe(false);
  });
});

describe('the bot', () => {
  it('reads the transcript after a line with the call pass', async () => {
    const view = {
      id: 'sess-1234',
      status: 'in-call',
      endedReason: null,
      startedAt: '',
      title: 'Sync',
      invited: [],
      lines: [],
      last: 7,
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }));
    await expect(readMeeting(meeting, 5, fetchImpl as unknown as typeof fetch)).resolves.toEqual(view);
    expect(fetchImpl).toHaveBeenCalledWith('https://bot.example.com/sessions/sess-1234?since=5', {
      headers: { Authorization: 'Bearer mbg_x.y' },
      cache: 'no-store',
    });
  });

  it('says when it no longer has the call, and removes Bash AI with a POST', async () => {
    const gone = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(readMeeting(meeting, 0, gone as unknown as typeof fetch)).rejects.toBeInstanceOf(MeetingGoneError);
    const ok = vi.fn(async () => new Response(JSON.stringify({ status: 'ended' }), { status: 200 }));
    await leaveMeeting(meeting, ok as unknown as typeof fetch);
    expect(ok).toHaveBeenCalledWith('https://bot.example.com/sessions/sess-1234/leave', {
      method: 'POST',
      headers: { Authorization: 'Bearer mbg_x.y' },
    });
  });
});

describe('the transcript', () => {
  it('adds only new lines, and keeps the latest', () => {
    const current = [line(1, 'note', 'Calling'), line(2, 'meeting', 'hi')];
    expect(mergeLines(current, [line(2, 'meeting', 'hi'), line(3, 'bash-ai', 'Hello')]).map(l => l.n)).toEqual([
      1, 2, 3,
    ]);
    const many = Array.from({ length: PANEL_LINES + 5 }, (_, i) => line(i + 1, 'meeting', `l${i}`));
    const kept = mergeLines([], many);
    expect(kept).toHaveLength(PANEL_LINES);
    expect(kept[0].n).toBe(6);
  });

  it('goes with a question as quoted text: the meeting, the invite list, Central times and who said it', () => {
    const quote = transcriptQuote({ title: 'Tech dev sync', invited: ['Zach Kostic (said yes)'] }, [
      line(1, 'note', 'Bash AI was admitted to the call.'),
      line(2, 'meeting', 'Bash AI, what is on the CSM calendar?'),
      line(3, 'bash-ai', 'Install America at 9 AM.'),
    ]);
    expect(quote).toContain('Live transcript of "Tech dev sync"');
    expect(quote).toContain('Invited: Zach Kostic (said yes).');
    expect(quote).toContain('cannot say who spoke');
    expect(quote).toContain('[11:42 PM] Meeting: Bash AI, what is on the CSM calendar?');
    expect(quote).toContain('[11:42 PM] Bash AI: Install America at 9 AM.');
    expect(quote).toContain('[11:42 PM] —: Bash AI was admitted to the call.');
    expect(transcriptQuote({ title: null, invited: [] }, [])).toContain('(nothing said yet)');
  });

  it('keeps the latest part of a long meeting', () => {
    const long = Array.from({ length: 2000 }, (_, i) => line(i + 1, 'meeting', `sentence number ${i} `.repeat(3)));
    const quote = transcriptQuote({ title: 'Long', invited: [] }, long);
    expect(quote).toContain('(earlier lines left out)');
    expect(quote).toContain('sentence number 1999');
    expect(quote.length).toBeLessThan(QUOTE_LIMIT + 500);
  });
});

describe('words in progress', () => {
  it('a line finishing words in progress keeps their id; finished ones drop out of the live list', () => {
    expect(lineId({ n: 7, key: 'm:item-1' })).toBe('m:item-1');
    expect(lineId({ n: 7 })).toBe('n7');
    const lines = [{ n: 1, at: '', who: 'meeting' as const, text: 'Bash AI, hi', key: 'm:a' }];
    const live = [
      { key: 'm:a', who: 'meeting' as const, text: 'Bash AI', at: '' },
      { key: 'b2', who: 'bash-ai' as const, text: 'Hi Aar', at: '' },
    ];
    expect(pendingLive(live, lines).map(l => l.key)).toEqual(['b2']);
    expect(pendingLive(undefined, lines)).toEqual([]);
  });
});
