/**
 * Unit tests for the provider-test localStorage cache.
 *
 * Test Coverage:
 * - get returns null when nothing's cached
 * - set followed by get round-trips ok + modelCount
 * - get returns null after the TTL expires (and purges the entry)
 * - clearCachedTestResult drops a single entry
 * - clearAllCachedTestResults wipes everything
 * - corrupt JSON in localStorage is treated as an empty cache (no throw)
 *
 * @see lib/orchestration/provider-test-cache.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  clearAllCachedTestResults,
  clearCachedTestResult,
  getCachedTestResult,
  setCachedTestResult,
} from '@/lib/orchestration/provider-test-cache';

const STORAGE_KEY = 'sunrise.orchestration.provider-test-cache.v1';

describe('provider-test cache', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('returns null when no entry is cached for the id', () => {
    expect(getCachedTestResult('prov-1')).toBeNull();
  });

  it('round-trips ok + modelCount through localStorage', () => {
    setCachedTestResult('prov-1', { ok: true, modelCount: 12 });

    const cached = getCachedTestResult('prov-1');

    expect(cached).not.toBeNull();
    expect(cached?.ok).toBe(true);
    expect(cached?.modelCount).toBe(12);
    expect(typeof cached?.testedAt).toBe('number');
  });

  it('expires after the 10-minute TTL and purges the entry on read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
    setCachedTestResult('prov-1', { ok: true, modelCount: 5 });

    // 9 minutes later — still fresh.
    vi.setSystemTime(new Date('2026-05-07T12:09:00Z'));
    expect(getCachedTestResult('prov-1')?.ok).toBe(true);

    // 11 minutes after the original cache write — expired.
    vi.setSystemTime(new Date('2026-05-07T12:11:00Z'));
    expect(getCachedTestResult('prov-1')).toBeNull();

    // The expired entry must have been purged from storage so the cache
    // doesn't grow unboundedly across long sessions.
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw ?? '{}');
    expect(parsed['prov-1']).toBeUndefined();
  });

  it('clearCachedTestResult drops only the targeted id', () => {
    setCachedTestResult('prov-1', { ok: true, modelCount: 1 });
    setCachedTestResult('prov-2', { ok: false, modelCount: 0 });

    clearCachedTestResult('prov-1');

    expect(getCachedTestResult('prov-1')).toBeNull();
    expect(getCachedTestResult('prov-2')).not.toBeNull();
  });

  it('clearAllCachedTestResults wipes every entry', () => {
    setCachedTestResult('prov-1', { ok: true, modelCount: 1 });
    setCachedTestResult('prov-2', { ok: true, modelCount: 2 });

    clearAllCachedTestResults();

    expect(getCachedTestResult('prov-1')).toBeNull();
    expect(getCachedTestResult('prov-2')).toBeNull();
  });

  it('treats corrupt JSON in localStorage as an empty cache rather than throwing', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not valid json');

    // Both reading and writing must continue to work — a corrupted
    // cache is recoverable, not a hard failure.
    expect(() => getCachedTestResult('prov-1')).not.toThrow();
    expect(getCachedTestResult('prov-1')).toBeNull();
    expect(() => setCachedTestResult('prov-1', { ok: true, modelCount: 3 })).not.toThrow();
  });

  it('persists the failure case so the red dot survives navigation too', () => {
    // Earlier versions only cached successes; failures stayed in
    // component state and were lost on navigation. The cache now stores
    // both so the dot reflects the truthful last-known status.
    setCachedTestResult('prov-1', { ok: false, modelCount: 0 });

    const cached = getCachedTestResult('prov-1');

    expect(cached?.ok).toBe(false);
  });
});
