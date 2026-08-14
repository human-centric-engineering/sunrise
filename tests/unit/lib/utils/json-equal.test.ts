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
    // The own-key COUNTS have to match for this to test what it claims. The
    // first version of this test used `Object.create({ a: 1 })`, whose own keys
    // number one against the other side's two — so it returned false at the
    // length check and would have passed just as happily with `key in b`.
    //
    // Polluting `Object.prototype` instead keeps both sides plain objects with
    // two own keys each, and puts the inherited `x` only on the side that does
    // not own it. `key in b` reports true for `x`, compares 1 to the inherited
    // 1, then matches `y` — and calls two different objects equal.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.x = 1;
    try {
      const b = { y: 2, w: 9 };
      expect('x' in b).toBe(true);
      expect(Object.keys(b)).toHaveLength(2);

      expect(jsonEquals({ x: 1, y: 2 }, b)).toBe(false);
    } finally {
      delete proto.x;
    }
  });

  it('reports non-plain objects UNEQUAL rather than comparing their empty key sets', () => {
    // `isRecord` is true for any non-array object, and `Date`/`Map`/`Set`/
    // `RegExp` all have zero own enumerable keys — so without the plain-object
    // guard each of these compares `{}` to `{}` and answers `true`. None are
    // JSON values, but "two different values are equal" is the worst way to
    // say so, and this helper is exported for reuse.
    expect(jsonEquals(new Date(0), new Date(1_000_000_000_000))).toBe(false);
    expect(jsonEquals(new Map([['a', 1]]), new Map([['b', 2]]))).toBe(false);
    expect(jsonEquals(new Set([1]), new Set([2]))).toBe(false);
    expect(jsonEquals(/a/, /b/)).toBe(false);

    class Thing {
      constructor(public v: number) {}
    }
    expect(jsonEquals(new Thing(1), new Thing(2))).toBe(false);
    // Even matching contents: the guard does not try to decide, it declines.
    expect(jsonEquals(new Date(0), new Date(0))).toBe(false);
    // A non-plain object is never equal to the plain object it mirrors.
    expect(jsonEquals(new Thing(1), { v: 1 })).toBe(false);
  });

  it('still compares the same instance as equal, via the identity fast path', () => {
    const d = new Date(0);
    expect(jsonEquals(d, d)).toBe(true);
  });

  it('compares a null-prototype object as the plain object it is', () => {
    // `Object.create(null)` is what a JSON parser may hand back in hardened
    // code, and it is a JSON value in every sense that matters here.
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;

    expect(jsonEquals(bare, { a: 1 })).toBe(true);
    expect(jsonEquals(bare, { a: 2 })).toBe(false);
  });

  it('handles deeply nested structures without blowing up', () => {
    const deep = (depth: number): unknown =>
      depth === 0 ? 'leaf' : { z: depth, a: deep(depth - 1) };

    expect(jsonEquals(deep(50), deep(50))).toBe(true);
    expect(jsonEquals(deep(50), deep(49))).toBe(false);
  });
});
