/**
 * Tests for `lib/utils/json-equal.ts`.
 *
 * The reason this helper exists is the key-order case: a `jsonb` value read
 * back from Postgres does not carry the key order it was written in, and a Zod
 * object rebuilds the parsed value in schema-declaration order. So the first
 * describe block below is the whole point — everything else guards it against
 * being "simplified" back into a `JSON.stringify` comparison.
 *
 * @see lib/utils/json-equal.ts
 * @see lib/orchestration/capabilities/seed-owned.ts — the caller
 */

import { describe, it, expect } from 'vitest';

import { jsonEquals } from '@/lib/utils/json-equal';

describe('jsonEquals — key order', () => {
  it('treats objects differing only in key order as equal', () => {
    const fromPostgres = { name: 'x', parameters: { type: 'object' }, description: 'd' };
    const fromZod = { name: 'x', description: 'd', parameters: { type: 'object' } };

    // The exact failure this function exists to prevent: stringify says no.
    expect(JSON.stringify(fromPostgres)).not.toBe(JSON.stringify(fromZod));
    expect(jsonEquals(fromPostgres, fromZod)).toBe(true);
  });

  it('ignores key order at every depth, not just the top level', () => {
    const a = { p: { b: 1, a: { d: 4, c: 3 } } };
    const b = { p: { a: { c: 3, d: 4 }, b: 1 } };

    expect(jsonEquals(a, b)).toBe(true);
  });

  it('ignores key order inside objects nested in arrays', () => {
    const a = { required: [{ name: 'q', type: 'string' }] };
    const b = { required: [{ type: 'string', name: 'q' }] };

    expect(jsonEquals(a, b)).toBe(true);
  });
});

describe('jsonEquals — genuine differences', () => {
  it('reports a changed nested value', () => {
    expect(jsonEquals({ p: { a: 1 } }, { p: { a: 2 } })).toBe(false);
  });

  it('reports an added key', () => {
    expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('reports a removed key', () => {
    expect(jsonEquals({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('reports a key renamed to another key of the same count', () => {
    // Key COUNT matches, so a length-only check would call these equal.
    expect(jsonEquals({ a: 1 }, { b: 1 })).toBe(false);
  });

  it('does not conflate a value with its string form', () => {
    expect(jsonEquals({ a: 1 }, { a: '1' })).toBe(false);
    expect(jsonEquals(1, '1')).toBe(false);
    expect(jsonEquals(true, 'true')).toBe(false);
  });
});

describe('jsonEquals — arrays', () => {
  it('treats array order as significant', () => {
    // A JSON array is a sequence. `parameters.required: ['a','b']` is not the
    // same schema as `['b','a']` to anything that renders it.
    expect(jsonEquals(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(jsonEquals(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('reports a length difference', () => {
    expect(jsonEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonEquals([], [1])).toBe(false);
  });

  it('never treats an array as equal to an object', () => {
    // `Object.keys([])` and `Object.keys({})` are both empty, so a naive
    // record comparison would call these equal.
    expect(jsonEquals([], {})).toBe(false);
    expect(jsonEquals({}, [])).toBe(false);
    expect(jsonEquals(['a'], { 0: 'a' })).toBe(false);
  });
});

describe('jsonEquals — null and undefined', () => {
  it('does not treat null as equal to an empty object or array', () => {
    // `typeof null === 'object'`, so this is the classic fall-through.
    expect(jsonEquals(null, {})).toBe(false);
    expect(jsonEquals({}, null)).toBe(false);
    expect(jsonEquals(null, [])).toBe(false);
  });

  it('keeps null and undefined distinct', () => {
    // They are distinct in `jsonb` too — a stored SQL NULL is not a stored
    // JSON null, and neither is an absent field.
    expect(jsonEquals(null, undefined)).toBe(false);
    expect(jsonEquals(undefined, null)).toBe(false);
  });

  it('treats identical nullish values as equal', () => {
    expect(jsonEquals(null, null)).toBe(true);
    expect(jsonEquals(undefined, undefined)).toBe(true);
  });

  it('distinguishes an explicit null property from an absent one', () => {
    expect(jsonEquals({ a: null }, {})).toBe(false);
    expect(jsonEquals({ a: null }, { a: null })).toBe(true);
  });
});

describe('jsonEquals — primitives and hostile input', () => {
  it('compares primitives by value', () => {
    expect(jsonEquals(1, 1)).toBe(true);
    expect(jsonEquals('a', 'a')).toBe(true);
    expect(jsonEquals(false, false)).toBe(true);
    expect(jsonEquals(1, 2)).toBe(false);
  });

  it('does not accept an inherited property in place of an own one', () => {
    const polluted = Object.create({ a: 1 }) as Record<string, unknown>;
    polluted.b = 2;

    // `'a' in polluted` is true, so a `key in b` check would pass this.
    expect(jsonEquals({ a: 1, b: 2 }, polluted)).toBe(false);
  });

  it('handles deeply nested structures without blowing up', () => {
    const deep = (depth: number): unknown =>
      depth === 0 ? 'leaf' : { z: depth, a: deep(depth - 1) };

    expect(jsonEquals(deep(50), deep(50))).toBe(true);
    expect(jsonEquals(deep(50), deep(49))).toBe(false);
  });
});
