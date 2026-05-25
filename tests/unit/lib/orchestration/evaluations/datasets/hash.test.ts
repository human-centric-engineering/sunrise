/**
 * Additional branch-coverage tests for the dataset content-hash helper.
 *
 * `parsers.test.ts` already covers the happy paths (same content → same
 * hash, position sensitivity, sorted metadata keys). This file pins the
 * remaining branches: nested arrays-of-objects canonicalisation,
 * explicit-null vs undefined for referenceCitations, mixed input types,
 * empty input, deep key-order equivalence.
 */

import { describe, it, expect } from 'vitest';
import { hashDatasetCases, hashParsedCases } from '@/lib/orchestration/evaluations/datasets/hash';

describe('hashDatasetCases — additional branches', () => {
  it('returns a stable hex digest for an empty cases array', () => {
    const h = hashDatasetCases([]);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    // Same input always produces same hash.
    expect(hashDatasetCases([])).toBe(h);
  });

  it('canonicalises objects nested inside arrays (sorted-key recursion through array map)', () => {
    // referenceCitations is an array of objects → canonicalise hits the
    // Array.isArray branch and recurses into each object, sorting its keys.
    const a = [
      {
        position: 0,
        input: 'Q',
        referenceCitations: [
          { z: 1, a: 2, m: { y: 'y', x: 'x' } },
          { b: 'b', a: 'a' },
        ],
      },
    ];
    const b = [
      {
        position: 0,
        input: 'Q',
        referenceCitations: [
          { a: 2, m: { x: 'x', y: 'y' }, z: 1 },
          { a: 'a', b: 'b' },
        ],
      },
    ];
    expect(hashDatasetCases(a)).toBe(hashDatasetCases(b));
  });

  it('canonicalises deeply nested arrays inside metadata', () => {
    const a = [
      {
        position: 0,
        input: 'Q',
        metadata: {
          path: [
            [{ z: 1, a: 2 }, { b: 3 }],
            ['plain', 'string'],
          ],
        },
      },
    ];
    const b = [
      {
        position: 0,
        input: 'Q',
        metadata: {
          path: [
            [{ a: 2, z: 1 }, { b: 3 }],
            ['plain', 'string'],
          ],
        },
      },
    ];
    expect(hashDatasetCases(a)).toBe(hashDatasetCases(b));
  });

  it('treats explicit null referenceCitations the same as undefined (both normalise to null)', () => {
    // Branch coverage: `referenceCitations !== undefined ? canonicalise(...) : null`
    // — when value is `null`, !== undefined is true so canonicalise(null) is taken,
    // which falls through to the `return value` (primitive) branch and yields null.
    const withNull = [
      { position: 0, input: 'Q', referenceCitations: null as unknown as undefined },
    ];
    const withUndef = [{ position: 0, input: 'Q' }];
    expect(hashDatasetCases(withNull)).toBe(hashDatasetCases(withUndef));
  });

  it('treats explicit null metadata the same as undefined', () => {
    // Same branch logic as above for metadata.
    const withNull = [{ position: 0, input: 'Q', metadata: null as unknown as undefined }];
    const withUndef = [{ position: 0, input: 'Q' }];
    expect(hashDatasetCases(withNull)).toBe(hashDatasetCases(withUndef));
  });

  it('strips undefined fields from canonical objects (does not include them in the JSON)', () => {
    // Forces the `obj[key] === undefined` branch inside canonicalise.
    const a = [
      {
        position: 0,
        input: { a: 1, b: undefined, c: 3 } as unknown,
      },
    ];
    const b = [
      {
        position: 0,
        input: { a: 1, c: 3 } as unknown,
      },
    ];
    expect(hashDatasetCases(a)).toBe(hashDatasetCases(b));
  });

  it('distinguishes string input from object input with the same JSON-looking content', () => {
    // Mixed-types branch coverage: input can be a string OR an object.
    // A literal string `"Q"` and an object `{ q: 'Q' }` must hash differently.
    const stringInput = hashDatasetCases([{ position: 0, input: 'Q' }]);
    const objectInput = hashDatasetCases([{ position: 0, input: { q: 'Q' } }]);
    expect(stringInput).not.toBe(objectInput);
  });

  it('treats deeply nested objects with same content but different key order as identical', () => {
    const a = [
      {
        position: 0,
        input: { outer: { z: { c: 3, a: 1, b: 2 }, a: 'x' } } as unknown,
      },
    ];
    const b = [
      {
        position: 0,
        input: { outer: { a: 'x', z: { a: 1, b: 2, c: 3 } } } as unknown,
      },
    ];
    expect(hashDatasetCases(a)).toBe(hashDatasetCases(b));
  });

  it('handles a `null` value sitting at a non-top-level position (returns null branch)', () => {
    // canonicalise(null) — `value && typeof === 'object'` is false because
    // `null && ...` short-circuits to null (falsy). Hits the trailing
    // `return value` for the null case.
    const a = [{ position: 0, input: { nested: null } as unknown }];
    const b = [{ position: 0, input: { nested: null } as unknown }];
    expect(hashDatasetCases(a)).toBe(hashDatasetCases(b));
  });

  it('hashParsedCases on an empty array equals hashDatasetCases on an empty array', () => {
    expect(hashParsedCases([])).toBe(hashDatasetCases([]));
  });
});
