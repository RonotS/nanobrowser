// A conversation as Command Center keeps it (Assistant → Bash AI chats): what the person saw in the panel, in order.
// Their messages, the answers, one short label per step, and generated or saved files by name. Never the text of
// pages, never screenshots, and never what was typed into a page: a step names its target, not its value.
import type { DisplayEntry, ToolRow } from '@src/ui/protocol';

export interface HistoryStep {
  tool: string;
  status: string;
  detail?: string;
}

export type HistoryItem =
  | { kind: 'user'; text: string; at: string; files?: string[] }
  | { kind: 'assistant'; text: string; at: string; model?: string; steps?: HistoryStep[] }
  | { kind: 'notice'; text: string; at: string; tone?: string }
  | { kind: 'media'; text: string; at: string; name: string; model?: string }
  | { kind: 'file'; text: string; at: string; name: string };

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The receipt's target without its ref: "[a2] button «Send»" reads as "button «Send»". */
function target(row: ToolRow): string {
  const receipt = (row.result as { receipt?: { target?: string } } | undefined)?.receipt;
  return (receipt?.target ?? '').replace(/^\[[^\]]*\]\s*/, '');
}

/** A step's short label: where it went or what it acted on; never a typed value. */
export function stepDetail(row: ToolRow): string {
  const args = (row.args ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  switch (row.tool) {
    case 'navigate':
      return text(args.url) || text(args.action);
    case 'tabs':
      return [text(args.action) || 'list', text(args.url)].filter(Boolean).join(' ');
    case 'command_center_read':
    case 'command_center_action':
      return text(args.tool);
    case 'generate_image':
    case 'generate_video':
      return cut(text(args.prompt), 160);
    case 'find':
      return text(args.name) || text(args.text) || text(args.role);
    case 'press':
      return text(args.keys);
    case 'click':
    case 'set':
    case 'type':
    case 'fill_form':
    case 'hover':
    case 'scroll':
    case 'upload':
    case 'handle_dialog':
      return target(row);
    default:
      return '';
  }
}

export function historyTranscript(entries: DisplayEntry[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case 'user': {
        const files = (e.attachments ?? []).map(a => a.name);
        out.push({ kind: 'user', text: e.text, at: e.at, ...(files.length ? { files } : {}) });
        break;
      }
      case 'assistant': {
        // A `done` that went through says no more than the answer under it.
        const steps = e.tools
          .filter(r => r.tool !== 'done' || r.status === 'failed' || r.status === 'skipped')
          .map(r => {
            const detail = cut(stepDetail(r), 300);
            return { tool: r.tool, status: r.status, ...(detail ? { detail } : {}) };
          });
        if (!e.text.trim() && !steps.length) break;
        out.push({
          kind: 'assistant',
          text: e.text,
          at: e.at,
          ...(e.model ? { model: e.model.model } : {}),
          ...(steps.length ? { steps } : {}),
        });
        break;
      }
      case 'notice':
        out.push({ kind: 'notice', text: e.text, at: e.at, tone: e.tone });
        break;
      case 'media':
        out.push({ kind: 'media', text: cut(e.prompt, 300), at: e.at, name: e.name, model: e.model });
        break;
      case 'download':
        out.push({ kind: 'file', text: '', at: e.at, name: e.name });
        break;
    }
  }
  return out;
}
