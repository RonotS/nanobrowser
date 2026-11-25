// Image and video generation on OpenAI's and xAI's APIs, called at a base URL (Command Center's route for the
// provider, which adds the key). Knows nothing about browsers: inputs and outputs are bytes.
//
// xAI: https://docs.x.ai/developers/model-capabilities/images/generation, .../images/editing, .../video/generation
// OpenAI: https://platform.openai.com/docs/api-reference/images

export type MediaProvider = 'openai' | 'grok';

export interface MediaEndpoint {
  /** The provider's API root, without the endpoint (Command Center's /api/ai-browser/llm/<service>). */
  baseUrl: string;
  fetch: typeof fetch;
}

export interface MediaFile {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  count: number;
  aspectRatio?: string;
  /** Images to start from: edited or restyled. */
  references: MediaFile[];
}

export interface VideoRequest {
  model: string;
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  /** The first frame, to animate an image. */
  image?: MediaFile;
}

export class MediaError extends Error {}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

export const dataUri = (file: MediaFile) => `data:${file.mimeType};base64,${base64(file.bytes)}`;

/** The provider's own words for a refusal, from either API's error shape. */
async function refusal(response: Response): Promise<MediaError> {
  const text = await response.text().catch(() => '');
  let message = text.slice(0, 400);
  try {
    const body = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
    message = (typeof body.error === 'string' ? body.error : body.error?.message) ?? body.message ?? message;
  } catch {
    // Not JSON: the text as it is.
  }
  return new MediaError(`${response.status}: ${message || response.statusText}`);
}

/** OpenAI's image sizes, nearest to an aspect ratio: square, landscape or portrait. */
export function openaiSize(aspectRatio?: string): string {
  if (!aspectRatio || aspectRatio === '1:1') return '1024x1024';
  const [w, h] = aspectRatio.split(':').map(Number);
  return w > h ? '1536x1024' : '1024x1536';
}

interface ImageAnswer {
  data?: Array<{ b64_json?: string | null; url?: string | null; mime_type?: string }>;
  output_format?: string;
}

export async function generateImages(
  provider: MediaProvider,
  endpoint: MediaEndpoint,
  request: ImageRequest,
  signal?: AbortSignal,
): Promise<MediaFile[]> {
  let response: Response;
  if (provider === 'grok') {
    // xAI takes JSON for both: an edit names its images as data URIs (one as `image`, several as `images`).
    const refs = request.references.map(file => ({ url: dataUri(file) }));
    const body = {
      model: request.model,
      prompt: request.prompt,
      n: request.count,
      response_format: 'b64_json',
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(refs.length === 1 ? { image: refs[0] } : refs.length > 1 ? { images: refs } : {}),
    };
    response = await endpoint.fetch(`${endpoint.baseUrl}/images/${refs.length ? 'edits' : 'generations'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } else if (request.references.length) {
    // OpenAI's edits take JSON too, each image as a data URL (developers.openai.com, images/edit).
    response = await endpoint.fetch(`${endpoint.baseUrl}/images/edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        n: request.count,
        size: openaiSize(request.aspectRatio),
        images: request.references.map(file => ({ image_url: dataUri(file) })),
      }),
      signal,
    });
  } else {
    response = await endpoint.fetch(`${endpoint.baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        n: request.count,
        size: openaiSize(request.aspectRatio),
      }),
      signal,
    });
  }
  if (!response.ok) throw await refusal(response);
  const answer = (await response.json()) as ImageAnswer;
  const files: MediaFile[] = [];
  for (const item of answer.data ?? []) {
    if (item.b64_json) {
      const format = item.mime_type ?? (answer.output_format ? `image/${answer.output_format}` : 'image/png');
      files.push({ bytes: fromBase64(item.b64_json), mimeType: format });
    }
  }
  if (!files.length) throw new MediaError('The model sent no image (it may have refused the prompt).');
  return files;
}

interface VideoStatus {
  status?: 'pending' | 'done' | 'failed' | 'expired';
  progress?: number;
  video?: { url?: string; duration?: number; respect_moderation?: boolean };
  error?: { code?: string; message?: string };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new MediaError('Stopped.'));
    });
  });

/**
 * A video from xAI: the job is started, polled every five seconds for up to ten minutes, then the finished MP4 is
 * fetched from the short-lived address xAI gives (a public link, so it is fetched as it is).
 */
export async function generateVideo(
  endpoint: MediaEndpoint,
  request: VideoRequest,
  options: {
    signal?: AbortSignal;
    onProgress?: (percent: number) => void;
    /** Fetches the finished file; the global fetch when absent. */
    download?: typeof fetch;
    /** Between polls; five seconds when absent. */
    pollMs?: number;
  } = {},
): Promise<MediaFile & { duration?: number }> {
  const start = await endpoint.fetch(`${endpoint.baseUrl}/videos/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model,
      prompt: request.prompt,
      resolution: '720p',
      ...(request.duration ? { duration: request.duration } : {}),
      ...(request.aspectRatio && !request.image ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.image ? { image: { url: dataUri(request.image) } } : {}),
    }),
    signal: options.signal,
  });
  if (!start.ok) throw await refusal(start);
  const { request_id: id } = (await start.json()) as { request_id?: string };
  if (!id) throw new MediaError('xAI did not start the video.');
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new MediaError('The video took more than ten minutes; try a shorter one.');
    await sleep(options.pollMs ?? 5_000, options.signal);
    const poll = await endpoint.fetch(`${endpoint.baseUrl}/videos/${encodeURIComponent(id)}`, {
      signal: options.signal,
    });
    if (!poll.ok && poll.status !== 202) throw await refusal(poll);
    const status = (await poll.json()) as VideoStatus;
    if (status.status === 'failed' || status.status === 'expired') {
      throw new MediaError(status.error?.message ?? `The video ${status.status}.`);
    }
    if (status.status !== 'done') {
      if (typeof status.progress === 'number') options.onProgress?.(status.progress);
      continue;
    }
    const url = status.video?.url;
    if (!url) throw new MediaError('xAI withheld the video (moderation).');
    const file = await (options.download ?? globalThis.fetch)(url, { signal: options.signal });
    if (!file.ok) throw new MediaError(`The finished video could not be fetched (${file.status}).`);
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.headers.get('content-type')?.split(';')[0] || 'video/mp4',
      ...(status.video?.duration ? { duration: status.video.duration } : {}),
    };
  }
}

export function extensionOf(mimeType: string): string {
  const sub = mimeType.split('/')[1]?.split(';')[0] ?? 'bin';
  return sub === 'jpeg' ? 'jpg' : sub;
}
