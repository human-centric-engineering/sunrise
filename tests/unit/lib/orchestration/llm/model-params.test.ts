import { describe, expect, it } from 'vitest';

import {
  modelParamOptions,
  narrowServiceTier,
  narrowVerbosity,
} from '@/lib/orchestration/llm/model-params';

describe('modelParamOptions', () => {
  it('passes every set value through', () => {
    expect(
      modelParamOptions({
        stopSequences: ['END', '###'],
        topP: 0.9,
        verbosity: 'high',
        parallelToolCalls: false,
        serviceTier: 'priority',
      })
    ).toEqual({
      stopSequences: ['END', '###'],
      topP: 0.9,
      verbosity: 'high',
      parallelToolCalls: false,
      serviceTier: 'priority',
    });
  });

  it('leaves unset values out, so the provider default applies', () => {
    expect(
      modelParamOptions({
        stopSequences: [],
        topP: null,
        verbosity: null,
        parallelToolCalls: null,
        serviceTier: null,
      })
    ).toEqual({});
    expect(modelParamOptions({})).toEqual({});
  });

  it('keeps a 0 top_p and an explicit true, which are settings, not absence', () => {
    expect(modelParamOptions({ topP: 0, parallelToolCalls: true })).toEqual({
      topP: 0,
      parallelToolCalls: true,
    });
  });

  it('drops a stored value outside its enum instead of forwarding it to a 400', () => {
    // The columns are plain TEXT; raw SQL or a fork's bundle can hold anything.
    expect(modelParamOptions({ verbosity: 'verbose', serviceTier: 'turbo' })).toEqual({});
  });

  it('drops whitespace-only stop sequences, which Anthropic refuses', () => {
    expect(modelParamOptions({ stopSequences: ['  ', '\t', 'END'] })).toEqual({
      stopSequences: ['END'],
    });
  });

  it('drops empty stop sequences and keeps at most four', () => {
    expect(modelParamOptions({ stopSequences: ['a', '', 'b', 'c', 'd', 'e'] })).toEqual({
      stopSequences: ['a', 'b', 'c', 'd'],
    });
  });
});

describe('narrowVerbosity / narrowServiceTier', () => {
  it('narrow known values and reject the rest', () => {
    expect(narrowVerbosity('medium')).toBe('medium');
    expect(narrowVerbosity('MEDIUM')).toBeUndefined();
    expect(narrowServiceTier('flex')).toBe('flex');
    expect(narrowServiceTier('scale')).toBeUndefined();
    expect(narrowServiceTier(null)).toBeUndefined();
  });
});
