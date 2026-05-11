/**
 * audio-default helpers
 *
 * Tiny unit test pinning the composite encoding contract that the
 * audio default uses across the form, PATCH validator, runtime
 * resolver, and matrix reverse-index. Any change to the wire format
 * starts here.
 *
 * @see lib/orchestration/llm/audio-default.ts
 */

import { describe, it, expect } from 'vitest';
import { formatAudioDefault, parseAudioDefault } from '@/lib/orchestration/llm/audio-default';

describe('formatAudioDefault', () => {
  it('joins providerSlug and modelId with the canonical separator', () => {
    expect(formatAudioDefault('openai', 'whisper-1')).toBe('openai::whisper-1');
  });

  it('roundtrips with parseAudioDefault for arbitrary slugs and modelIds', () => {
    const cases: Array<[string, string]> = [
      ['openai', 'whisper-1'],
      ['groq', 'whisper-large-v3'],
      // Model ids can contain dashes, dots, and forward slashes
      // (Together's `openai/whisper-large-v3`, OpenRouter-style names).
      ['together', 'openai/whisper-large-v3'],
      ['fireworks', 'accounts/fireworks/models/whisper-v3'],
    ];
    for (const [slug, id] of cases) {
      const encoded = formatAudioDefault(slug, id);
      expect(parseAudioDefault(encoded)).toEqual({ providerSlug: slug, modelId: id });
    }
  });
});

describe('parseAudioDefault', () => {
  it('returns null for empty / undefined values so callers can use it as a presence check', () => {
    expect(parseAudioDefault('')).toBeNull();
    expect(parseAudioDefault(null)).toBeNull();
    expect(parseAudioDefault(undefined)).toBeNull();
  });

  it('splits on the FIRST :: so model ids that contain :: keep the tail intact', () => {
    // Constructed case: a hypothetical model id like `foo::bar` paired
    // with provider `openai` encodes to `openai::foo::bar`. We treat
    // everything after the first `::` as the modelId.
    expect(parseAudioDefault('openai::foo::bar')).toEqual({
      providerSlug: 'openai',
      modelId: 'foo::bar',
    });
  });

  it('treats a bare model id as a legacy value with no provider scope', () => {
    // Settings rows written before the composite encoding landed will
    // still parse — callers fall back to bare-modelId matching when
    // providerSlug is null. The legacy path is short-lived (next save
    // rewrites with the composite) but must not crash today.
    expect(parseAudioDefault('whisper-1')).toEqual({
      providerSlug: null,
      modelId: 'whisper-1',
    });
  });

  it('falls back to the legacy single-id interpretation for malformed composites', () => {
    // `::whisper-1` (empty provider) and `openai::` (empty model) are
    // both meaningless. Treat the whole string as a legacy modelId so
    // the runtime matcher's bare-modelId fallback at least has
    // something to compare; the alternative is a half-formed
    // {providerSlug, modelId} that the matcher would silently accept.
    expect(parseAudioDefault('::whisper-1')).toEqual({
      providerSlug: null,
      modelId: '::whisper-1',
    });
    expect(parseAudioDefault('openai::')).toEqual({
      providerSlug: null,
      modelId: 'openai::',
    });
  });
});
