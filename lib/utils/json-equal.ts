/**
 * Structural equality for JSON values, insensitive to object key order.
 *
 * **Why not `JSON.stringify(a) === JSON.stringify(b)`.** The two sides of these
 * comparisons routinely serialise the same value to different strings:
 *
 * - Postgres stores `jsonb` in its own canonical key order (shortest key first,
 *   then bytewise), so a value read back from the database does not preserve
 *   the order it was written in.
 * - A Zod object rebuilds the parsed value in *schema* declaration order, so a
 *   client echoing a definition straight back gets a third ordering.
 *
 * A stringify comparison therefore reports "changed" for a byte-identical
 * value, which is how #598's guard 403'd saves that changed nothing.
 *
 * Two other helpers in the codebase deliberately do use stringify equality
 * (`agent-version-diff.ts`, `apply-audit-changes.ts`); both compare values
 * produced by the *same* code path on both sides, where key order is stable.
 * Reach for this one whenever either side has been through Postgres or Zod.
 *
 * Semantics: `undefined` equals only `undefined`; `undefined` and `null` are
 * distinct (they are in `jsonb` too). Object comparison ignores keys whose
 * value is `undefined` on neither side — JSON has no such value, so any input
 * carrying one is already outside the domain and is compared literally.
 * Non-JSON values (functions, symbols) compare by identity via `===`; so do
 * non-plain objects (`Date`, `Map`, `Set`, `RegExp`, class instances), which
 * are otherwise reported UNEQUAL — see {@link isPlainObject}.
 */

import { isRecord } from '@/lib/utils';

/**
 * A `{}` or `Object.create(null)` object — not a `Date`, `Map`, `Set`,
 * `RegExp` or class instance.
 *
 * `isRecord` is true for ANY non-array object, and every one of those types
 * has an empty set of own enumerable keys — so without this check
 * `jsonEquals(new Date(0), new Date(1e12))` compares `{}` to `{}` and answers
 * `true`. Same for two `Map`s with different contents, or `/a/` and `/b/`.
 *
 * None of them are JSON values, so a caller holding one is outside this
 * function's domain either way; the choice is only in how it says so, and
 * "these two different values are equal" is the worst available answer.
 * Identical instances still compare equal via the `a === b` fast path.
 */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // `null` is an object in JS; catch it before the record checks below so
  // `jsonEquals(null, {})` does not fall through to key comparison.
  if (a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    // Order IS significant for arrays — a JSON array is a sequence, and
    // `parameters.required: ['a','b']` is not the same schema as `['b','a']`
    // to every consumer that renders it.
    return a.every((item, i) => jsonEquals(item, b[i]));
  }

  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    // `Object.keys` order differs between the two sides by construction — that
    // is the entire point of this function — so compare as a set by looking
    // each of `a`'s keys up in `b`. `Object.prototype.hasOwnProperty.call`
    // rather than `key in b`, so an inherited property cannot stand in for an
    // own one on a prototype-polluted input.
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEquals(a[key], b[key])
    );
  }

  // Primitives that were not `===` above. NaN is not valid JSON (it
  // serialises to `null`), so no special case is warranted.
  return false;
}
