// Media generation for the agent: `generate_image` and `generate_video`, on the image and video models Command Center
// offers (OpenAI's and Grok's, run on the company's keys). What they make is kept with the conversation as an attached
// file: the panel shows it with Save, and the agent can put it into a page with `upload`.
import type { AgentTool } from './tools';

export const GENERATE_IMAGE = 'generate_image';
export const GENERATE_VIDEO = 'generate_video';

export interface MediaModelInfo {
  provider: 'openai' | 'grok';
  name: string;
  label?: string;
}

export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

const ATTACHMENT_ID = { type: 'string', description: 'The id of an attached or generated file in this conversation' };

/** The tools for the models Command Center offers; none of a kind it offers none of. */
export function mediaAgentTools(media: { image: MediaModelInfo[]; video: MediaModelInfo[] }): AgentTool[] {
  const out: AgentTool[] = [];
  if (media.image.length) {
    out.push({
      name: GENERATE_IMAGE,
      source: 'agent',
      group: 'files',
      description:
        'Make images from a description: ad creatives, mock-ups, illustrations. Optionally start from images attached to or made in this conversation (to edit or restyle them). Each image is kept with the conversation as an attached file with an id; the user sees it, and upload can put it into a page.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What the image shows, in detail: subject, setting, style, text on it',
          },
          model: {
            type: 'string',
            enum: media.image.map(m => m.name),
            description: `Leave it out for ${media.image[0].name}`,
          },
          aspect_ratio: { type: 'string', enum: [...ASPECT_RATIOS] },
          count: { type: 'integer', minimum: 1, maximum: 4, description: 'How many versions; 1 when left out' },
          reference_ids: { type: 'array', items: ATTACHMENT_ID, maxItems: 4 },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    });
  }
  if (media.video.length) {
    out.push({
      name: GENERATE_VIDEO,
      source: 'agent',
      group: 'files',
      description:
        'Make a short video from a description, or animate an image attached to or made in this conversation. Takes a minute or more. The video is kept with the conversation as an attached file with an id.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What happens in the video: subject, motion, camera, style' },
          model: {
            type: 'string',
            enum: media.video.map(m => m.name),
            description: `Leave it out for ${media.video[0].name}`,
          },
          aspect_ratio: { type: 'string', enum: [...ASPECT_RATIOS] },
          duration: { type: 'integer', minimum: 1, maximum: 15, description: 'Seconds' },
          image_id: ATTACHMENT_ID,
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    });
  }
  return out;
}

export interface MediaRequest {
  kind: 'image' | 'video';
  model: MediaModelInfo;
  prompt: string;
  aspectRatio?: AspectRatio;
  count: number;
  duration?: number;
  /** Attachment ids to start from. */
  references: string[];
}

/** Reads a call's arguments against the models offered; a string says what is wrong. */
export function mediaRequest(
  tool: string,
  args: Record<string, unknown>,
  media: { image: MediaModelInfo[]; video: MediaModelInfo[] },
): MediaRequest | string {
  const kind = tool === GENERATE_VIDEO ? 'video' : 'image';
  const models = media[kind];
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return 'Give a prompt that describes what to make.';
  if (prompt.length > 4000) return 'The prompt is too long: 4,000 characters at most.';
  const model = args.model === undefined ? models[0] : models.find(m => m.name === args.model);
  if (!model)
    return `There is no ${kind} model ${String(args.model)}. Use one of: ${models.map(m => m.name).join(', ')}.`;
  const aspectRatio = ASPECT_RATIOS.find(r => r === args.aspect_ratio);
  if (args.aspect_ratio !== undefined && !aspectRatio)
    return `aspect_ratio must be one of ${ASPECT_RATIOS.join(', ')}.`;
  const count = kind === 'image' ? Math.min(4, Math.max(1, Math.round(Number(args.count ?? 1)) || 1)) : 1;
  const duration =
    args.duration === undefined ? undefined : Math.min(15, Math.max(1, Math.round(Number(args.duration))));
  const ids = kind === 'image' ? args.reference_ids : args.image_id === undefined ? [] : [args.image_id];
  const references = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  return {
    kind,
    model,
    prompt,
    count,
    references,
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(duration && Number.isFinite(duration) ? { duration } : {}),
  };
}
