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

  // The shape that actually shows up. Any real hostname resolves to A AND
  // AAAA, so undici tries both and reports an AggregateError whose own
  // `message` is '' — reading `cause.message` alone returned the bare
  // 'fetch failed' this module exists to prevent.
  it('uses the aggregated per-address failures when the cause message is empty', () => {
    const cause = Object.assign(
      new AggregateError(
        [
          new Error('connect ECONNREFUSED ::1:49999'),
          new Error('connect ECONNREFUSED 127.0.0.1:49999'),
        ],
        ''
      ),
      { code: 'ECONNREFUSED' }
    );

    expect(describeFetchFailure(Object.assign(new TypeError('fetch failed'), { cause }))).toBe(
      'fetch failed: connect ECONNREFUSED ::1:49999; connect ECONNREFUSED 127.0.0.1:49999'
    );
  });

  it('collapses identical per-address failures', () => {
    const cause = new AggregateError([new Error('same reason'), new Error('same reason')], '');

    expect(describeFetchFailure(Object.assign(new Error('fetch failed'), { cause }))).toBe(
      'fetch failed: same reason'
    );
  });

  it('falls back to the error code when there is nothing else', () => {
    const cause = Object.assign(new Error(''), { code: 'ENOTFOUND' });

    expect(describeFetchFailure(Object.assign(new Error('fetch failed'), { cause }))).toBe(
      'fetch failed: ENOTFOUND'
    );
  });

  it('prefers a real cause message over the code', () => {
    const cause = Object.assign(new Error('unexpected redirect'), { code: 'UND_ERR_REDIRECT' });

    expect(describeFetchFailure(Object.assign(new Error('fetch failed'), { cause }))).toBe(
      'fetch failed: unexpected redirect'
    );
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
