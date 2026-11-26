import { describe, expect, it } from 'vitest';
import { voiceChat } from '../voice-history';

describe('saving a voice call', () => {
  const record = {
    id: 'abc',
    startedAt: '2026-11-25T21:30:00.000Z',
    model: 'grok-voice-latest',
    lines: [
      { who: 'you' as const, text: 'Open the  Command Center\nand show payments', at: '2026-11-25T21:30:05.000Z' },
      { who: 'task' as const, text: 'Asked the browser: Open the Payments page', at: '2026-11-25T21:30:06.000Z' },
      { who: 'ai' as const, text: 'Opening Payments now.', at: '2026-11-25T21:30:07.000Z' },
    ],
  };

  it('is one conversation per call, titled from its first words, with each side and the browser notes', () => {
    const chat = voiceChat(record, false);
    expect(chat.externalId).toBe('voice-abc');
    expect(chat.title).toBe('Voice call: Open the Command Center and show payments');
    expect(chat.status).toBe('running');
    expect(chat.lastMessageAt).toBe('2026-11-25T21:30:07.000Z');
    expect(chat.transcript).toEqual([
      { kind: 'user', text: 'Open the  Command Center\nand show payments', at: '2026-11-25T21:30:05.000Z' },
      {
        kind: 'notice',
        text: 'Asked the browser: Open the Payments page',
        at: '2026-11-25T21:30:06.000Z',
        tone: 'info',
      },
      { kind: 'assistant', text: 'Opening Payments now.', at: '2026-11-25T21:30:07.000Z', model: 'grok-voice-latest' },
    ]);
    expect(voiceChat(record, true).status).toBe('done');
    expect(voiceChat({ ...record, lines: [] }, true).title).toBe('Voice call');
  });
});
