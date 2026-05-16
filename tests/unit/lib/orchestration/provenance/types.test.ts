/**
 * Tests for `lib/orchestration/provenance/types.ts` — the ProvenanceItem
 * Zod schema and the `extractProvenance` helper the engine uses to lift
 * a step's `output.sources` onto its trace entry.
 *
 * The contract under test is documented in `.context/orchestration/provenance.md`.
 */

import { describe, expect, it } from 'vitest';
import {
  extractProvenance,
  provenanceItemArraySchema,
  provenanceItemSchema,
  provenanceSourceSchema,
  type ProvenanceItem,
} from '@/lib/orchestration/provenance/types';

describe('provenanceSourceSchema', () => {
  it.each([
    'training_knowledge',
    'web_search',
    'knowledge_base',
    'prior_step',
    'external_call',
    'user_input',
  ])('accepts %s as a valid source kind', (kind) => {
    expect(provenanceSourceSchema.safeParse(kind).success).toBe(true);
  });

  it('rejects unknown source kinds', () => {
    expect(provenanceSourceSchema.safeParse('inference').success).toBe(false);
    expect(provenanceSourceSchema.safeParse('').success).toBe(false);
    expect(provenanceSourceSchema.safeParse(null).success).toBe(false);
  });
});

describe('provenanceItemSchema', () => {
  const validWebSearch: ProvenanceItem = {
    source: 'web_search',
    confidence: 'high',
    reference: 'https://example.com/article',
    snippet: 'Model X is a general-purpose chat LLM, not an embedding model.',
    note: 'official release notes',
  };

  it('accepts a fully populated web_search item', () => {
    expect(provenanceItemSchema.safeParse(validWebSearch).success).toBe(true);
  });

  it('accepts a training_knowledge item with only source + confidence', () => {
    const minimal = { source: 'training_knowledge', confidence: 'low' };
    expect(provenanceItemSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects items missing source', () => {
    const { source: _omit, ...rest } = validWebSearch;
    void _omit;
    expect(provenanceItemSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects items with invalid confidence value', () => {
    const bad = { ...validWebSearch, confidence: 'certain' };
    expect(provenanceItemSchema.safeParse(bad).success).toBe(false);
  });

  it('enforces length cap on snippet', () => {
    const oversize = { ...validWebSearch, snippet: 'a'.repeat(500) };
    expect(provenanceItemSchema.safeParse(oversize).success).toBe(false);
  });

  it('enforces length cap on note', () => {
    const oversize = { ...validWebSearch, note: 'b'.repeat(500) };
    expect(provenanceItemSchema.safeParse(oversize).success).toBe(false);
  });

  it('rejects empty-string optional fields', () => {
    const empty = { ...validWebSearch, snippet: '' };
    expect(provenanceItemSchema.safeParse(empty).success).toBe(false);
  });
});

describe('provenanceItemArraySchema', () => {
  it('accepts an empty array (producer chose to emit zero sources)', () => {
    expect(provenanceItemArraySchema.safeParse([]).success).toBe(true);
  });

  it('caps the array at 64 entries', () => {
    const tooMany = Array.from({ length: 65 }, () => ({
      source: 'training_knowledge' as const,
      confidence: 'low' as const,
    }));
    expect(provenanceItemArraySchema.safeParse(tooMany).success).toBe(false);
  });

  it('rejects when any entry is malformed', () => {
    const mixed = [
      { source: 'web_search', confidence: 'high', reference: 'https://example.com' },
      { source: 'invalid_kind', confidence: 'high' },
    ];
    expect(provenanceItemArraySchema.safeParse(mixed).success).toBe(false);
  });
});

describe('extractProvenance', () => {
  it('returns undefined for non-object outputs', () => {
    expect(extractProvenance(null)).toBeUndefined();
    expect(extractProvenance(undefined)).toBeUndefined();
    expect(extractProvenance('string output')).toBeUndefined();
    expect(extractProvenance(42)).toBeUndefined();
    expect(extractProvenance([])).toBeUndefined();
  });

  it('returns undefined when output.sources is missing', () => {
    expect(extractProvenance({ result: 'ok' })).toBeUndefined();
  });

  it('returns undefined when output.sources is null', () => {
    expect(extractProvenance({ sources: null })).toBeUndefined();
  });

  it('returns undefined when output.sources is empty (no claim to surface)', () => {
    expect(extractProvenance({ sources: [] })).toBeUndefined();
  });

  it('returns undefined when output.sources is malformed', () => {
    expect(
      extractProvenance({
        sources: [{ source: 'made_up_kind', confidence: 'high' }],
      })
    ).toBeUndefined();
  });

  it('returns the normalised array for valid sources', () => {
    const sources: ProvenanceItem[] = [
      {
        source: 'web_search',
        confidence: 'high',
        reference: 'https://example.com',
      },
      {
        source: 'training_knowledge',
        confidence: 'low',
        note: 'inferred from model name pattern',
      },
    ];
    expect(extractProvenance({ sources })).toEqual(sources);
  });

  it('does not require the source array to be the only field on output', () => {
    const output = {
      models: [{ name: 'A' }],
      sources: [{ source: 'web_search' as const, confidence: 'high' as const, reference: 'u' }],
      extra: 123,
    };
    expect(extractProvenance(output)).toHaveLength(1);
  });
});
