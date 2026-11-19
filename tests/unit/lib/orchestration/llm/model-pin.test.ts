/**
 * model-pin helpers
 *
 * A model pin is stored as `provider::model`, or a bare model id (anything
 * saved before §136 t-1068). These tests pin the parsing contract every
 * reader of a task default or a step `modelOverride` relies on.
 *
 * @see lib/orchestration/llm/model-pin.ts
 */

import { describe, it, expect } from 'vitest';
import {
  formatModelPin,
  parseModelPin,
  pinModelId,
  pinNames,
  pinProvider,
} from '@/lib/orchestration/llm/model-pin';
import { formatAudioDefault, parseAudioDefault } from '@/lib/orchestration/llm/audio-default';

describe('formatModelPin', () => {
  it('joins provider slug and model id with ::', () => {
    expect(formatModelPin('microsoft', 'gpt-4o')).toBe('microsoft::gpt-4o');
  });

  it('round-trips through parseModelPin, including ids that contain ::', () => {
    expect(parseModelPin(formatModelPin('azure', 'ft::gpt-4o::v2'))).toEqual({
      providerSlug: 'azure',
      modelId: 'ft::gpt-4o::v2',
    });
  });
});

describe('parseModelPin', () => {
  it('reads provider::model as a pair', () => {
    expect(parseModelPin('microsoft::gpt-4o')).toEqual({
      providerSlug: 'microsoft',
      modelId: 'gpt-4o',
    });
  });

  it('reads a value with no separator as a bare id with no provider', () => {
    expect(parseModelPin('gpt-4o')).toEqual({ providerSlug: null, modelId: 'gpt-4o' });
  });

  it('splits on the FIRST :: so the model id keeps later separators', () => {
    expect(parseModelPin('a::b::c')).toEqual({ providerSlug: 'a', modelId: 'b::c' });
  });

  it('reads a value with an empty provider side as a whole bare id', () => {
    expect(parseModelPin('::gpt-4o')).toEqual({ providerSlug: null, modelId: '::gpt-4o' });
  });

  it('reads a value with an empty model side as a whole bare id', () => {
    expect(parseModelPin('openai::')).toEqual({ providerSlug: null, modelId: 'openai::' });
  });

  it('returns null for an empty string, null and undefined', () => {
    expect(parseModelPin('')).toBeNull();
    expect(parseModelPin(null)).toBeNull();
    expect(parseModelPin(undefined)).toBeNull();
  });
});

describe('pinModelId', () => {
  it('returns the model id of a pair', () => {
    expect(pinModelId('microsoft::gpt-4o')).toBe('gpt-4o');
  });

  it('returns a bare id unchanged', () => {
    expect(pinModelId('gpt-4o')).toBe('gpt-4o');
  });

  it('returns the empty string when there is no pin', () => {
    expect(pinModelId(null)).toBe('');
    expect(pinModelId(undefined)).toBe('');
    expect(pinModelId('')).toBe('');
  });
});

describe('pinNames', () => {
  const openai = { providerSlug: 'openai', modelId: 'gpt-4o' };

  it("returns 'pair' when provider and id both match", () => {
    expect(pinNames('openai::gpt-4o', openai)).toBe('pair');
  });

  it("returns 'id' for a bare id that matches the model id", () => {
    expect(pinNames('gpt-4o', openai)).toBe('id');
  });

  it('returns null for a pair that names another provider with the same id', () => {
    expect(pinNames('microsoft::gpt-4o', openai)).toBeNull();
  });

  it('returns null when the model id differs, for a pair and for a bare id', () => {
    expect(pinNames('openai::gpt-4o-mini', openai)).toBeNull();
    expect(pinNames('gpt-4o-mini', openai)).toBeNull();
  });

  it('returns null when there is no pin', () => {
    expect(pinNames(null, openai)).toBeNull();
    expect(pinNames(undefined, openai)).toBeNull();
    expect(pinNames('', openai)).toBeNull();
  });
});

describe('pinProvider', () => {
  it("prefers the pin's own provider over the registry's", () => {
    expect(pinProvider({ providerSlug: 'microsoft', modelId: 'gpt-4o' }, 'openai')).toBe(
      'microsoft'
    );
  });

  it("falls back to the registry's provider for a bare pin", () => {
    expect(pinProvider({ providerSlug: null, modelId: 'gpt-4o' }, 'openai')).toBe('openai');
  });
});

describe('audio-default re-exports', () => {
  it('formatAudioDefault and parseAudioDefault share the model-pin encoding', () => {
    expect(formatAudioDefault('groq', 'whisper-1')).toBe(formatModelPin('groq', 'whisper-1'));
    expect(parseAudioDefault('groq::whisper-1')).toEqual(parseModelPin('groq::whisper-1'));
  });
});
