// A voice call, saved to Command Center like a chat (Aaron 2026-11-25: "save the voice conversation too"). Before
// this, only the browser tasks a call started were saved; what was said lived on screen and was gone with the panel.
// Each call is its own conversation in Command Center (Assistant → Bash AI chats), titled from its first words: the
// person's lines as their messages, Bash AI's spoken answers as its answers, and a note for each browser task.
import type { ChatForCommandCenter } from '@src/store/command-center';

export interface VoiceRecordLine {
  /** you: the person · ai: Bash AI's spoken answer · task: a note about a browser task */
  who: 'you' | 'ai' | 'task';
  text: string;
  at: string;
}

export interface VoiceRecord {
  id: string;
  startedAt: string;
  /** The voice model's name, as the history shows it beside an answer. */
  model: string;
  lines: VoiceRecordLine[];
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The call as a chat for Command Center: `ended` false while it goes on. */
export function voiceChat(record: VoiceRecord, ended: boolean): ChatForCommandCenter {
  const first = record.lines.find(l => l.who === 'you')?.text.trim();
  return {
    externalId: `voice-${record.id}`,
    title: first ? `Voice call: ${cut(first.replace(/\s+/g, ' '), 80)}` : 'Voice call',
    status: ended ? 'done' : 'running',
    startedAt: record.startedAt,
    lastMessageAt: record.lines.at(-1)?.at ?? record.startedAt,
    transcript: record.lines.map(line =>
      line.who === 'you'
        ? { kind: 'user', text: line.text, at: line.at }
        : line.who === 'ai'
          ? { kind: 'assistant', text: line.text, at: line.at, model: record.model }
          : { kind: 'notice', text: line.text, at: line.at, tone: 'info' },
    ),
  };
}
