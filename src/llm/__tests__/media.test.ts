import { describe, expect, it } from 'vitest';
import { extensionOf, generateImages, generateVideo, openaiSize } from '../media';

const PNG = { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' };
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

/** A fetch that records each request and answers from a list. */
function recorder(answers: Array<Response | (() => Response)>) {
  const sent: Array<{ url: string; method: string; body: unknown }> = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    const next = answers.shift()!;
    return typeof next === 'function' ? next() : next;
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

describe('image generation', () => {
  it('asks OpenAI for a size near the aspect ratio and reads the base64 image', async () => {
    const { sent, fetch } = recorder([Response.json({ data: [{ b64_json: b64([1, 2]) }], output_format: 'png' })]);
    const files = await generateImages(
      'openai',
      { baseUrl: 'https://cc/llm/openai', fetch },
      {
        model: 'gpt-image-2.6-flare',
        prompt: 'a vanity',
        count: 1,
        aspectRatio: '16:9',
        references: [],
      },
    );
    expect(sent[0]).toEqual({
      url: 'https://cc/llm/openai/images/generations',
      method: 'POST',
      body: { model: 'gpt-image-2.6-flare', prompt: 'a vanity', n: 1, size: '1536x1024' },
    });
    expect(files).toEqual([{ bytes: new Uint8Array([1, 2]), mimeType: 'image/png' }]);
  });

  it('sends OpenAI edits as JSON with data URLs', async () => {
    const { sent, fetch } = recorder([Response.json({ data: [{ b64_json: b64([3]) }] })]);
    await generateImages(
      'openai',
      { baseUrl: 'https://cc/llm/openai', fetch },
      {
        model: 'gpt-image-2.6-sunburst',
        prompt: 'make it blue',
        count: 2,
        references: [PNG],
      },
    );
    expect(sent[0].url).toBe('https://cc/llm/openai/images/edits');
    expect(sent[0].body).toMatchObject({
      n: 2,
      size: '1024x1024',
      images: [{ image_url: 'data:image/png;base64,iVBORw==' }],
    });
  });

  it('asks xAI for base64 with its own aspect ratio, as an edit when there are images to start from', async () => {
    const { sent, fetch } = recorder([
      Response.json({ data: [{ b64_json: b64([9]), mime_type: 'image/jpeg' }] }),
      Response.json({ data: [{ b64_json: b64([8]), mime_type: 'image/jpeg' }] }),
    ]);
    const endpoint = { baseUrl: 'https://cc/llm/xai', fetch };
    const made = await generateImages('grok', endpoint, {
      model: 'grok-imagine-image-2.0',
      prompt: 'p',
      count: 1,
      aspectRatio: '9:16',
      references: [],
    });
    await generateImages('grok', endpoint, {
      model: 'grok-imagine-image-2.0',
      prompt: 'p',
      count: 1,
      references: [PNG, PNG],
    });
    expect(sent[0]).toMatchObject({
      url: 'https://cc/llm/xai/images/generations',
      body: { response_format: 'b64_json', aspect_ratio: '9:16', n: 1 },
    });
    expect(made[0].mimeType).toBe('image/jpeg');
    expect(sent[1].url).toBe('https://cc/llm/xai/images/edits');
    expect((sent[1].body as { images: unknown[] }).images).toHaveLength(2);
  });

  it('passes on the provider’s refusal, and says so when no image came back', async () => {
    const { fetch } = recorder([
      Response.json({ error: { message: 'Your request was rejected by the safety system.' } }, { status: 400 }),
      Response.json({ data: [] }),
    ]);
    const endpoint = { baseUrl: 'https://cc', fetch };
    const request = { model: 'm', prompt: 'p', count: 1, references: [] };
    await expect(generateImages('openai', endpoint, request)).rejects.toThrow('400: Your request was rejected');
    await expect(generateImages('openai', endpoint, request)).rejects.toThrow(/sent no image/);
  });
});

describe('video generation', () => {
  it('starts the job, polls it until done, then fetches the file', async () => {
    const { sent, fetch } = recorder([
      Response.json({ request_id: 'req-1' }),
      new Response(JSON.stringify({ status: 'pending', progress: 40 }), { status: 202 }),
      Response.json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4', duration: 3 } }),
    ]);
    const progress: number[] = [];
    const downloads: string[] = [];
    const download = (async (url: string) => {
      downloads.push(String(url));
      return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { 'content-type': 'video/mp4' } });
    }) as typeof globalThis.fetch;
    const video = await generateVideo(
      { baseUrl: 'https://cc/llm/xai', fetch },
      { model: 'grok-imagine-video-1.5-lite', prompt: 'a pan', duration: 3, aspectRatio: '16:9' },
      { onProgress: p => progress.push(p), download, pollMs: 1 },
    );
    expect(sent[0]).toEqual({
      url: 'https://cc/llm/xai/videos/generations',
      method: 'POST',
      body: {
        model: 'grok-imagine-video-1.5-lite',
        prompt: 'a pan',
        resolution: '720p',
        duration: 3,
        aspect_ratio: '16:9',
      },
    });
    expect(sent.slice(1).map(s => [s.method, s.url])).toEqual([
      ['GET', 'https://cc/llm/xai/videos/req-1'],
      ['GET', 'https://cc/llm/xai/videos/req-1'],
    ]);
    expect(progress).toEqual([40]);
    expect(downloads).toEqual(['https://vidgen.x.ai/v.mp4']);
    expect(video).toMatchObject({ mimeType: 'video/mp4', duration: 3 });
  });

  it('animates an image: the image is the first frame and the aspect ratio follows it', async () => {
    const { sent, fetch } = recorder([
      Response.json({ request_id: 'r' }),
      Response.json({ status: 'failed', error: { message: 'Prompt rejected' } }),
    ]);
    await expect(
      generateVideo(
        { baseUrl: 'https://cc', fetch },
        { model: 'm', prompt: 'p', aspectRatio: '16:9', image: PNG },
        { pollMs: 1 },
      ),
    ).rejects.toThrow('Prompt rejected');
    expect(sent[0].body).toEqual({
      model: 'm',
      prompt: 'p',
      resolution: '720p',
      image: { url: 'data:image/png;base64,iVBORw==' },
    });
  });
});

describe('helpers', () => {
  it('maps aspect ratios to OpenAI sizes and media types to file extensions', () => {
    expect(['1:1', '4:3', '3:4', undefined].map(openaiSize)).toEqual([
      '1024x1024',
      '1536x1024',
      '1024x1536',
      '1024x1024',
    ]);
    expect(['image/jpeg', 'image/png', 'video/mp4'].map(extensionOf)).toEqual(['jpg', 'png', 'mp4']);
  });
});
