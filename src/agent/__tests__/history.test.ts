import { describe, expect, it } from 'vitest';
import type { DisplayEntry } from '@src/ui/protocol';
import { historyTranscript, stepDetail } from '../history';

const AT = '2026-11-25T15:00:00.000Z';

describe('the history Command Center keeps', () => {
  it('keeps messages, answers with step labels, notices and files, in order', () => {
    const entries: DisplayEntry[] = [
      {
        kind: 'user',
        id: 'u1',
        text: 'Log into GHL',
        at: AT,
        attachments: [{ id: 'a', name: 'brief.pdf', mimeType: 'application/pdf', size: 1 }],
      },
      {
        kind: 'assistant',
        id: 'r1',
        text: 'Logged in.',
        at: AT,
        model: { providerId: 'cc-claude', model: 'claude-sonnet-5-5' },
        tools: [
          { toolCallId: '1', tool: 'navigate', args: { url: 'https://app.gohighlevel.com' }, status: 'done' },
          {
            toolCallId: '2',
            tool: 'type',
            args: { ref: 'a4', text: 'hunter2' },
            status: 'done',
            result: { receipt: { target: '[a4] textbox «Password»' } },
          },
          {
            toolCallId: '3',
            tool: 'command_center_read',
            args: { tool: 'list_clients', arguments: {} },
            status: 'done',
          },
          { toolCallId: '4', tool: 'done', args: {}, status: 'done' },
        ],
      },
      {
        kind: 'media',
        id: 'm1',
        attachmentId: 'x',
        name: 'image-1.png',
        mimeType: 'image/png',
        bytes: 9,
        model: 'gpt-image-2.6-flare',
        prompt: 'an ad',
        at: AT,
      },
      { kind: 'download', id: 'd1', name: 'leads.csv', downloadId: 3, bytes: 10, at: AT },
      { kind: 'notice', id: 'n1', text: 'Stopped', tone: 'info', at: AT },
    ];
    expect(historyTranscript(entries)).toEqual([
      { kind: 'user', text: 'Log into GHL', at: AT, files: ['brief.pdf'] },
      {
        kind: 'assistant',
        text: 'Logged in.',
        at: AT,
        model: 'claude-sonnet-5-5',
        steps: [
          { tool: 'navigate', status: 'done', detail: 'https://app.gohighlevel.com' },
          { tool: 'type', status: 'done', detail: 'textbox «Password»' },
          { tool: 'command_center_read', status: 'done', detail: 'list_clients' },
        ],
      },
      { kind: 'media', text: 'an ad', at: AT, name: 'image-1.png', model: 'gpt-image-2.6-flare' },
      { kind: 'file', text: '', at: AT, name: 'leads.csv' },
      { kind: 'notice', text: 'Stopped', at: AT, tone: 'info' },
    ]);
  });

  it('never keeps what was typed into a page', () => {
    const typed = historyTranscript([
      {
        kind: 'assistant',
        id: 'r',
        text: '',
        at: AT,
        tools: [
          { toolCallId: '1', tool: 'type', args: { text: 'hunter2' }, status: 'done' },
          {
            toolCallId: '2',
            tool: 'fill_form',
            args: { fields: [{ ref: 'a1', value: '4111 1111 1111 1111' }] },
            status: 'done',
          },
        ],
      },
    ]);
    expect(JSON.stringify(typed)).not.toMatch(/hunter2|4111/);
  });

  it('labels a generation by its prompt and a Command Center call by its tool', () => {
    expect(
      stepDetail({ toolCallId: '1', tool: 'generate_image', args: { prompt: 'p'.repeat(400) }, status: 'done' }),
    ).toHaveLength(160);
    expect(
      stepDetail({
        toolCallId: '1',
        tool: 'command_center_action',
        args: { tool: 'add_client_note' },
        status: 'failed',
      }),
    ).toBe('add_client_note');
  });
});
