import { describe, expect, it } from 'vitest';
import { GENERATE_IMAGE, GENERATE_VIDEO, mediaAgentTools, mediaRequest } from '../media';
import { kindOf } from '../tools';

const MEDIA = {
  image: [
    { provider: 'openai' as const, name: 'gpt-image-2.6-flare' },
    { provider: 'grok' as const, name: 'grok-imagine-image-2.0' },
  ],
  video: [{ provider: 'grok' as const, name: 'grok-imagine-video-1.5' }],
};

describe('media tools', () => {
  it('offers one tool per kind Command Center has models for, naming only those models', () => {
    const tools = mediaAgentTools(MEDIA);
    expect(tools.map(t => t.name)).toEqual([GENERATE_IMAGE, GENERATE_VIDEO]);
    const models = (t: (typeof tools)[number]) =>
      (t.parameters as { properties: { model: { enum: string[] } } }).properties.model.enum;
    expect(models(tools[0])).toEqual(['gpt-image-2.6-flare', 'grok-imagine-image-2.0']);
    expect(mediaAgentTools({ image: MEDIA.image, video: [] }).map(t => t.name)).toEqual([GENERATE_IMAGE]);
    expect(mediaAgentTools({ image: [], video: [] })).toEqual([]);
  });

  it('runs as a step that makes a file, never in parallel with reads', () => {
    expect(kindOf(GENERATE_IMAGE, {})).toBe('state');
    expect(kindOf(GENERATE_VIDEO, {})).toBe('state');
  });

  it('reads an image request, with the first model when none is named', () => {
    expect(
      mediaRequest(GENERATE_IMAGE, { prompt: ' A kitchen remodel ad ', count: 9, aspect_ratio: '9:16' }, MEDIA),
    ).toEqual({
      kind: 'image',
      model: MEDIA.image[0],
      prompt: 'A kitchen remodel ad',
      count: 4,
      aspectRatio: '9:16',
      references: [],
    });
    expect(
      mediaRequest(GENERATE_IMAGE, { prompt: 'x', model: 'grok-imagine-image-2.0', reference_ids: ['a1', 7] }, MEDIA),
    ).toMatchObject({ model: MEDIA.image[1], references: ['a1'] });
  });

  it('reads a video request, one at a time, with the image to animate', () => {
    expect(
      mediaRequest(GENERATE_VIDEO, { prompt: 'A drone shot', duration: 40, image_id: 'img1', count: 3 }, MEDIA),
    ).toEqual({
      kind: 'video',
      model: MEDIA.video[0],
      prompt: 'A drone shot',
      count: 1,
      duration: 15,
      references: ['img1'],
    });
  });

  it('says what is wrong instead of guessing', () => {
    expect(mediaRequest(GENERATE_IMAGE, {}, MEDIA)).toMatch(/prompt/);
    expect(mediaRequest(GENERATE_IMAGE, { prompt: 'x', model: 'dall-e-3' }, MEDIA)).toMatch(/no image model dall-e-3/);
    expect(mediaRequest(GENERATE_IMAGE, { prompt: 'x', aspect_ratio: '2:1' }, MEDIA)).toMatch(/aspect_ratio/);
    expect(mediaRequest(GENERATE_VIDEO, { prompt: 'x' }, { image: MEDIA.image, video: [] })).toMatch(/no video model/);
  });
});
