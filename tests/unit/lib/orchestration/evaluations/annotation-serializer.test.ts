/**
 * Annotation Serializer Tests
 *
 * Covers round-trip fidelity, edge cases, and malformed metadata handling
 * for the evaluation annotation serialization layer.
 *
 * @see lib/orchestration/evaluations/annotation-serializer.ts
 */

import { describe, it, expect } from 'vitest';
import {
  type Annotation,
  serializeAnnotations,
  deserializeAnnotations,
  CATEGORIES,
} from '@/lib/orchestration/evaluations/annotation-serializer';

// ─── Helpers ────────────────────────────────────────────────────────────────

function ann(category: Annotation['category'] = null, rating = 3, notes = ''): Annotation {
  return { category, rating, notes };
}

// ─── serializeAnnotations ───────────────────────────────────────────────────

describe('serializeAnnotations', () => {
  it('returns ann_count=0 for an empty map', () => {
    const result = serializeAnnotations(new Map());
    expect(result).toEqual({ ann_count: 0 });
  });

  it('skips default annotations (no category, rating=3, empty notes)', () => {
    const map = new Map<number, Annotation>();
    map.set(0, ann()); // all defaults
    map.set(1, ann(null, 3, ''));

    const result = serializeAnnotations(map);
    expect(result).toEqual({ ann_count: 0 });
  });

  it('serializes a single non-default annotation', () => {
    const map = new Map<number, Annotation>();
    map.set(2, ann('issue', 1, 'Bad response'));

    const result = serializeAnnotations(map);
    expect(result).toEqual({
      ann_0_idx: 2,
      ann_0_cat: 'issue',
      ann_0_rat: 1,
      ann_0_notes: 'Bad response',
      ann_count: 1,
    });
  });

  it('serializes multiple annotations preserving order', () => {
    const map = new Map<number, Annotation>();
    map.set(0, ann('expected', 5, ''));
    map.set(3, ann('observation', 4, 'Interesting'));

    const result = serializeAnnotations(map);
    expect(result.ann_count).toBe(2);
    expect(result.ann_0_idx).toBe(0);
    expect(result.ann_0_cat).toBe('expected');
    expect(result.ann_1_idx).toBe(3);
    expect(result.ann_1_cat).toBe('observation');
  });

  it('serializes null notes as null (not empty string)', () => {
    const map = new Map<number, Annotation>();
    map.set(0, ann('expected', 5, ''));

    const result = serializeAnnotations(map);
    expect(result.ann_0_notes).toBeNull();
  });

  it('mixes default and non-default annotations correctly', () => {
    const map = new Map<number, Annotation>();
    map.set(0, ann()); // default — skipped
    map.set(1, ann('issue', 2, 'Flagged'));
    map.set(2, ann()); // default — skipped
    map.set(3, ann('expected', 5, ''));

    const result = serializeAnnotations(map);
    expect(result.ann_count).toBe(2);
    expect(result.ann_0_idx).toBe(1);
    expect(result.ann_1_idx).toBe(3);
  });

  it('preserves special characters in notes', () => {
    const map = new Map<number, Annotation>();
    map.set(0, ann('issue', 1, 'Line1\nLine2\ttab "quotes" <html>'));

    const result = serializeAnnotations(map);
    expect(result.ann_0_notes).toBe('Line1\nLine2\ttab "quotes" <html>');
  });
});

// ─── deserializeAnnotations ─────────────────────────────────────────────────

describe('deserializeAnnotations', () => {
  it('returns empty map for null metadata', () => {
    expect(deserializeAnnotations(null).size).toBe(0);
  });

  it('returns empty map for undefined metadata', () => {
    expect(deserializeAnnotations(undefined).size).toBe(0);
  });

  it('returns empty map when ann_count is missing', () => {
    expect(deserializeAnnotations({}).size).toBe(0);
  });

  it('returns empty map when ann_count is not a number', () => {
    expect(deserializeAnnotations({ ann_count: 'two' }).size).toBe(0);
  });

  it('deserializes a single annotation', () => {
    const metadata = {
      ann_0_idx: 2,
      ann_0_cat: 'issue',
      ann_0_rat: 1,
      ann_0_notes: 'Bad',
      ann_count: 1,
    };

    const map = deserializeAnnotations(metadata);
    expect(map.size).toBe(1);
    expect(map.get(2)).toEqual({ category: 'issue', rating: 1, notes: 'Bad' });
  });

  it('falls back to defaults for missing fields', () => {
    const metadata = {
      ann_0_idx: 0,
      // cat, rat, notes all missing
      ann_count: 1,
    };

    const map = deserializeAnnotations(metadata);
    expect(map.get(0)).toEqual({ category: null, rating: 3, notes: '' });
  });

  it('falls back to defaults for wrong field types', () => {
    const metadata = {
      ann_0_idx: 0,
      ann_0_cat: 42, // should be string
      ann_0_rat: 'five', // should be number
      ann_0_notes: true, // should be string
      ann_count: 1,
    };

    const map = deserializeAnnotations(metadata);
    expect(map.get(0)).toEqual({ category: null, rating: 3, notes: '' });
  });

  it('skips entries where idx is not a number', () => {
    const metadata = {
      ann_0_idx: 'zero', // invalid
      ann_0_cat: 'issue',
      ann_0_rat: 1,
      ann_0_notes: 'Note',
      ann_count: 1,
    };

    const map = deserializeAnnotations(metadata);
    expect(map.size).toBe(0);
  });

  it('deserializes multiple annotations', () => {
    const metadata = {
      ann_0_idx: 0,
      ann_0_cat: 'expected',
      ann_0_rat: 5,
      ann_0_notes: null,
      ann_1_idx: 3,
      ann_1_cat: 'observation',
      ann_1_rat: 4,
      ann_1_notes: 'Interesting',
      ann_count: 2,
    };

    const map = deserializeAnnotations(metadata);
    expect(map.size).toBe(2);
    expect(map.get(0)?.category).toBe('expected');
    expect(map.get(3)?.notes).toBe('Interesting');
  });
});

// ─── Round-trip ─────────────────────────────────────────────────────────────

describe('round-trip', () => {
  it('serialize → deserialize preserves data', () => {
    const original = new Map<number, Annotation>();
    original.set(0, ann('expected', 5, 'Great response'));
    original.set(2, ann('issue', 1, 'Hallucinated'));
    original.set(5, ann('observation', 3, ''));

    const serialized = serializeAnnotations(original);
    const restored = deserializeAnnotations(serialized);

    // Note: entry at index 5 has rating=3 and empty notes, but has a category
    // so it won't be skipped during serialization
    expect(restored.size).toBe(3);
    expect(restored.get(0)).toEqual(original.get(0));
    expect(restored.get(2)).toEqual(original.get(2));
    // Notes '' serializes as null, deserializes as ''
    expect(restored.get(5)?.category).toBe('observation');
    expect(restored.get(5)?.rating).toBe(3);
    expect(restored.get(5)?.notes).toBe('');
  });

  it('round-trips with all four categories', () => {
    const original = new Map<number, Annotation>();
    CATEGORIES.forEach((cat, i) => {
      original.set(i, ann(cat.value, i + 1, `Note for ${cat.label}`));
    });

    const restored = deserializeAnnotations(serializeAnnotations(original));
    expect(restored.size).toBe(4);
    CATEGORIES.forEach((cat, i) => {
      expect(restored.get(i)?.category).toBe(cat.value);
    });
  });
});
