/**
 * Tests for `describeFetchFailure`.
 *
 * undici surfaces almost every network-layer failure as a bare
 * `TypeError: fetch failed` with the real reason on `error.cause`. Three
 * outbound callers gained `redirect: 'error'` in #534/#553, and without the
 * unwrap a refused redirect is indistinguishable from a DNS miss in the
 * operator-visible delivery log.
 *
 * @see lib/errors/fetch-error.ts
 */

import { describe, it, expect } from 'vitest';
import { describeFetchFailure } from '@/lib/errors/fetch-error';

describe('describeFetchFailure', () => {
  it('appends an Error cause — the undici shape this exists for', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: new Error('unexpected redirect'),
    });

    expect(describeFetchFailure(err)).toBe('fetch failed: unexpected redirect');
  });

  it('appends a string cause', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: 'ECONNRESET' });

    expect(describeFetchFailure(err)).toBe('fetch failed: ECONNRESET');
  });

  it('returns the message unchanged when there is no cause', () => {
    expect(describeFetchFailure(new Error('boom'))).toBe('boom');
  });

  it.each([
    ['a plain object', { code: 'ENOTFOUND' }],
    ['an array', ['a']],
    ['a number', 42],
    ['null', null],
  ])('ignores %s as a cause rather than rendering "[object Object]"', (_label, cause) => {
    const err = Object.assign(new Error('fetch failed'), { cause });

    // The operator-visible log is better off with the bare message than with a
    // stringified object.
    expect(describeFetchFailure(err)).toBe('fetch failed');
  });

  it.each([
    ['a string', 'plain failure', 'plain failure'],
    ['a number', 500, '500'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('stringifies %s thrown as a non-Error', (_label, thrown, expected) => {
    expect(describeFetchFailure(thrown)).toBe(expected);
  });
});
