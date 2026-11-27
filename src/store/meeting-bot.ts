// Bash AI in a Google Meet (Aaron 2026-11-26): the meeting bot (the RonotS/meeting-bot service) dials into the meeting
// by phone, answers when someone says "Bash AI", and keeps a live transcript the side panel reads with the call's pass.
// Command Center starts it (startMeetingBot in ./command-center); this keeps the meeting the panel follows, reads the
// transcript from the bot, and removes Bash AI from the call.
import { createStorage } from './storage';

export type MeetingLineWho = 'meeting' | 'bash-ai' | 'note';

export interface MeetingLine {
  n: number;
  at: string;
  who: MeetingLineWho;
  text: string;
  /** The words-in-progress this line finishes (LiveMeetingLine.key), so the reveal carries on smoothly. */
  key?: string;
}

/** Words still being said (someone mid-sentence, Bash AI mid-answer): replaced by a line under the same key. */
export interface LiveMeetingLine {
  key: string;
  who: MeetingLineWho;
  text: string;
  at: string;
}

export type MeetingStatus = 'calling' | 'connected' | 'lobby' | 'in-call' | 'ended';

export interface MeetingView {
  id: string;
  status: MeetingStatus;
  endedReason: string | null;
  startedAt: string;
  title: string | null;
  invited: string[];
  lines: MeetingLine[];
  /** Words in progress (the bot sends them since Nov 27 2026; older bots leave this out). */
  live?: LiveMeetingLine[];
  last: number;
}

/** The meeting the panel follows. Kept in this browser only; the pass ends with the call (3 hours at most). */
export interface FollowedMeeting {
  sessionId: string;
  botUrl: string;
  grant: string;
  expiresAt: string;
  title: string | null;
  invited: string[];
  meetUrl: string | null;
  startedAt: string;
  /** In its own browser as "Bash AI", or by phone (older saves have none: phone). */
  mode?: 'browser' | 'phone';
}

export const meetingStorage = createStorage<FollowedMeeting | null>('kai.meetingBot', null, { liveUpdate: true });

/** "https://meet.google.com/uty-adfc-yff" for a tab in a Meet call; null for Meet's home page or any other page. */
export function meetCallUrl(url: string | null | undefined): string | null {
  const m = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/i.exec(url ?? '');
  return m ? `https://meet.google.com/${m[1].toLowerCase()}` : null;
}

/** A pasted "Join by phone" line has a phone number and a PIN. */
export function looksLikeDialIn(text: string): boolean {
  return /\d[\d\s().-]{6,}\d/.test(text) && /pin/i.test(text);
}

export class MeetingGoneError extends Error {}

function sessionUrl(meeting: Pick<FollowedMeeting, 'botUrl' | 'sessionId'>, suffix = ''): string {
  return `${meeting.botUrl.replace(/\/+$/, '')}/sessions/${encodeURIComponent(meeting.sessionId)}${suffix}`;
}

/** The call's status and the transcript lines after `since`. A call the bot no longer knows throws MeetingGoneError. */
export async function readMeeting(
  meeting: Pick<FollowedMeeting, 'botUrl' | 'sessionId' | 'grant'>,
  since: number,
  fetchImpl: typeof fetch = fetch,
): Promise<MeetingView> {
  const response = await fetchImpl(`${sessionUrl(meeting)}?since=${since}`, {
    headers: { Authorization: `Bearer ${meeting.grant}` },
    cache: 'no-store',
  });
  if (response.status === 404) throw new MeetingGoneError('The meeting bot no longer has this call.');
  if (!response.ok) throw new Error(`The meeting bot answered ${response.status}.`);
  return (await response.json()) as MeetingView;
}

/** Hangs Bash AI up. */
export async function leaveMeeting(
  meeting: Pick<FollowedMeeting, 'botUrl' | 'sessionId' | 'grant'>,
  fetchImpl: typeof fetch = fetch,
): Promise<MeetingView> {
  const response = await fetchImpl(sessionUrl(meeting, '/leave'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${meeting.grant}` },
  });
  if (response.status === 404) throw new MeetingGoneError('The meeting bot no longer has this call.');
  if (!response.ok) throw new Error(`The meeting bot answered ${response.status}.`);
  return (await response.json()) as MeetingView;
}

/** Lines kept in the panel (the bot keeps 4,000). */
export const PANEL_LINES = 1500;

/** New lines after the ones the panel has, without repeats, the latest PANEL_LINES. */
export function mergeLines(current: MeetingLine[], fresh: MeetingLine[]): MeetingLine[] {
  const last = current.at(-1)?.n ?? 0;
  const merged = [...current, ...fresh.filter(line => line.n > last)];
  return merged.length > PANEL_LINES ? merged.slice(-PANEL_LINES) : merged;
}

const WHO: Record<MeetingLineWho, string> = { meeting: 'Meeting', 'bash-ai': 'Bash AI', note: '—' };

/** "11:42 PM" in Central time, as the team reads it. */
export function lineClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(
    d,
  );
}

/** Characters of transcript sent with a question about the meeting: the latest part when it is longer. */
export const QUOTE_LIMIT = 24_000;

/**
 * The meeting's transcript as the quote a question about it carries (page text, so data, not instructions). The phone
 * line mixes voices, so lines say "Meeting", not who spoke.
 */
export function transcriptQuote(meeting: Pick<FollowedMeeting, 'title' | 'invited'>, lines: MeetingLine[]): string {
  const head = [
    `Live transcript of ${meeting.title ? `"${meeting.title}"` : 'a Google Meet'}, as Bash AI hears it on the phone line (Central time).`,
    'The phone line mixes everyone into one voice, so it cannot say who spoke.',
    meeting.invited.length ? `Invited: ${meeting.invited.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const body = lines.map(line => `[${lineClock(line.at)}] ${WHO[line.who]}: ${line.text}`);
  let text = body.join('\n');
  if (text.length > QUOTE_LIMIT) text = `… (earlier lines left out)\n${text.slice(text.length - QUOTE_LIMIT)}`;
  return `${head}\n\n${text || '(nothing said yet)'}`;
}

/** The id a line is revealed under: its live key when it finished words in progress, else its number. */
export function lineId(line: Pick<MeetingLine, 'n' | 'key'>): string {
  return line.key ?? `n${line.n}`;
}

/** Words in progress not yet replaced by their finished line. */
export function pendingLive(live: LiveMeetingLine[] | undefined, lines: MeetingLine[]): LiveMeetingLine[] {
  const done = new Set(lines.map(l => l.key).filter(Boolean));
  return (live ?? []).filter(l => !done.has(l.key));
}
