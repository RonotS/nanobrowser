import { describe, expect, it } from 'vitest';
import { CHAT_LIMIT, chatPrompt, isAddressed, splitChatMessage } from '../meeting-chat';

describe('a request to Bash AI in the call', () => {
  it('hears its name the ways Meet\'s captions write it, never Bashir or "Bash, I"', () => {
    for (const said of [
      'Bash AI, put the action items in the chat',
      'batch AI send that',
      'Bash A.I. post it',
      'BashAI?',
    ])
      expect(isAddressed(said)).toBe(true);
    for (const said of ['Bashir, can you send it', 'bash, I think we should', 'that was a bash'])
      expect(isAddressed(said)).toBe(false);
  });

  it('gives Claude the transcript, who asked and what', () => {
    const prompt = chatPrompt('Tech sync', '[9:01 AM] Zach: ship Friday', 'Aaron Santos', 'Bash AI, post the plan');
    expect(prompt).toContain('Meeting: Tech sync');
    expect(prompt).toContain('[9:01 AM] Zach: ship Friday');
    expect(prompt).toContain('The request, from Aaron Santos: "Bash AI, post the plan"');
  });

  it("splits a long message into pieces Meet's chat takes, at line or word breaks", () => {
    const items = Array.from({ length: 30 }, (_, i) => `- Item ${i + 1}: follow up with the client about the budget`);
    const parts = splitChatMessage(items.join('\n'));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(p => p.length <= CHAT_LIMIT)).toBe(true);
    expect(parts.join('\n')).toBe(items.join('\n'));
    expect(splitChatMessage('short')).toEqual(['short']);
  });
});
