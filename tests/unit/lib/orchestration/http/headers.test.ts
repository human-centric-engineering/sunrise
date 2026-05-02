/**
 * Tests for `lib/orchestration/http/headers.ts`.
 *
 * Covers the case-insensitive merge contract that closes the
 * forcedHeaders smuggling path flagged in the security review:
 *   - last source wins on the same logical (case-insensitive) header
 *   - undefined sources are skipped
 *   - the winning entry's original casing is preserved (so trace logs
 *     stay readable)
 *   - LLM-style lowercase header cannot coexist alongside an
 *     admin-supplied canonical-case one
 */

import { describe, expect, it } from 'vitest';

import { mergeHeaders } from '@/lib/orchestration/http/headers';

describe('mergeHeaders', () => {
  it('returns an empty object for no sources', () => {
    expect(mergeHeaders()).toEqual({});
  });

  it('skips undefined sources', () => {
    expect(mergeHeaders(undefined, { 'X-A': '1' }, undefined)).toEqual({ 'X-A': '1' });
  });

  it('merges disjoint sources verbatim', () => {
    expect(mergeHeaders({ 'X-A': '1' }, { 'X-B': '2' })).toEqual({ 'X-A': '1', 'X-B': '2' });
  });

  it('later source wins on identical-case key', () => {
    expect(mergeHeaders({ 'X-A': 'first' }, { 'X-A': 'second' })).toEqual({ 'X-A': 'second' });
  });

  it('later source wins on case-different key (admin Authorization beats LLM authorization)', () => {
    const out = mergeHeaders(
      { authorization: 'Bearer attacker' },
      { Authorization: 'Bearer admin-controlled' }
    );
    // Exactly one entry, on the casing of the winning (later) source.
    expect(Object.keys(out)).toHaveLength(1);
    expect(out).toEqual({ Authorization: 'Bearer admin-controlled' });
  });

  it('later source wins on case-different key (LLM lowercase beats earlier uppercase)', () => {
    // The contract is "last wins" — direction is symmetric. Useful guarantee
    // against any merge order regression.
    const out = mergeHeaders({ Authorization: 'first' }, { authorization: 'second' });
    expect(Object.keys(out)).toHaveLength(1);
    expect(out).toEqual({ authorization: 'second' });
  });

  it('handles multiple case-different collisions across many sources', () => {
    const out = mergeHeaders(
      { 'x-tenant-id': 'a' },
      { 'X-Tenant-Id': 'b' },
      { 'X-TENANT-ID': 'c' }
    );
    expect(Object.keys(out)).toHaveLength(1);
    expect(out).toEqual({ 'X-TENANT-ID': 'c' });
  });

  it('preserves distinct headers that only share a prefix', () => {
    const out = mergeHeaders({ 'X-A': '1', 'X-A-B': '2' });
    expect(out).toEqual({ 'X-A': '1', 'X-A-B': '2' });
  });
});
