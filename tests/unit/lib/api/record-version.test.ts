/**
 * Tests for `lib/api/record-version.ts` (§122 t-899).
 *
 * @see lib/api/record-version.ts
 */

import { describe, expect, it } from 'vitest';

import { assertCurrentVersion, recordVersion, requireIfMatch } from '@/lib/api/record-version';
import { PreconditionRequiredError, StaleRecordError } from '@/lib/api/errors';

function withIfMatch(value: string | null): Request {
  return new Request('http://localhost/x', {
    method: 'PATCH',
    headers: value === null ? {} : { 'If-Match': value },
  });
}

describe('recordVersion', () => {
  it('is a quoted strong ETag', () => {
    expect(recordVersion({ a: 1 })).toMatch(/^"[\w-]{27}"$/);
  });

  it('is the same for the same content, whatever order an object keeps its keys in', () => {
    expect(recordVersion({ a: 1, b: { c: 2, d: 3 } })).toBe(
      recordVersion({ b: { d: 3, c: 2 }, a: 1 })
    );
  });

  it('changes when any value changes, including one nested in an array', () => {
    const base = { list: ['ops@example.com', 'jane@example.com'], on: true };
    expect(recordVersion({ ...base, list: ['ops@example.com'] })).not.toBe(recordVersion(base));
    expect(recordVersion({ ...base, on: false })).not.toBe(recordVersion(base));
  });

  it('keeps array order, which is content', () => {
    expect(recordVersion(['a', 'b'])).not.toBe(recordVersion(['b', 'a']));
  });

  it('tells null from a missing key', () => {
    expect(recordVersion({ a: null })).not.toBe(recordVersion({}));
  });
});

describe('requireIfMatch', () => {
  it('drops weak tags beside a strong one', () => {
    expect(requireIfMatch(withIfMatch('W/"cache", "v1"'))).toEqual(['"v1"']);
  });

  it('returns the versions the header names', () => {
    expect(requireIfMatch(withIfMatch('"one"'))).toEqual(['"one"']);
    expect(requireIfMatch(withIfMatch(' "one" , "two" '))).toEqual(['"one"', '"two"']);
  });

  it.each([
    ['absent', null],
    ['empty', ''],
    ['only commas', ' , '],
    ['*', '*'],
    ['* among others', '"one", *'],
    ["only a weak tag (the settings GET's ETag)", 'W/"abc"'],
    ['only weak tags', 'W/"a", W/"b"'],
  ])('throws 428 when the header is %s', (_label, value) => {
    expect(() => requireIfMatch(withIfMatch(value))).toThrow(PreconditionRequiredError);
    try {
      requireIfMatch(withIfMatch(value));
    } catch (err) {
      expect(err).toMatchObject({ status: 428, code: 'PRECONDITION_REQUIRED' });
    }
  });
});

describe('assertCurrentVersion', () => {
  it('passes when the current version is among those loaded', () => {
    expect(() => assertCurrentVersion(['"old"', '"now"'], '"now"')).not.toThrow();
  });

  it('throws 412 STALE_RECORD when it is not', () => {
    expect(() => assertCurrentVersion(['"old"'], '"now"')).toThrow(StaleRecordError);
    try {
      assertCurrentVersion(['"old"'], '"now"');
    } catch (err) {
      expect(err).toMatchObject({ status: 412, code: 'STALE_RECORD' });
      expect((err as Error).message).toMatch(/changed since you opened it/i);
    }
  });
});
