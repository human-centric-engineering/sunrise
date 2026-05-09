/**
 * Client-side cache for provider connection-test results.
 *
 * Test results were previously held only in React component state, so
 * navigating away from the providers list (or refreshing) lost them and
 * the status dot reset to grey. That made the "Connected" green state
 * effectively useless — the operator had to re-test on every visit.
 *
 * This cache persists `{ ok, modelCount, testedAt }` per provider id in
 * `localStorage` with a 10-minute TTL. Long enough to be useful for
 * "tested it earlier this session"; short enough that a stale-after-
 * config-change green dot self-heals quickly.
 *
 * Invalidation contract: mutating actions on a provider (PATCH the row,
 * delete it, reactivate, reset its circuit breaker) MUST call
 * `clearCachedTestResult(id)` — the call site has the freshest signal
 * that the cached result no longer matches reality. The TTL is the
 * fallback for when those call sites miss something.
 *
 * Client-only by virtue of `localStorage` access — guarded with a
 * `typeof window` check so server components that import the helper
 * (none today, but possible) don't crash during SSR.
 */

import { z } from 'zod';

const STORAGE_KEY = 'sunrise.orchestration.provider-test-cache.v1';
const TTL_MS = 10 * 60 * 1000;

// Schema is authoritative: localStorage is external data (user-controlled,
// XSS-reachable, version-skewable across releases) so the cache is parsed
// through Zod on every read. A corrupt or partial entry yields `{}` rather
// than wrong-typed values surfacing in `setCachedTestResult`'s callers.
const cachedResultSchema = z.object({
  /** True when the most recent `/test` call returned `{ ok: true }`. */
  ok: z.boolean(),
  /** Length of the `models` array reported by `/test`. */
  modelCount: z.number(),
  /** Epoch ms when the test ran. */
  testedAt: z.number(),
});

const cacheShapeSchema = z.record(z.string(), cachedResultSchema);

export type CachedProviderTestResult = z.infer<typeof cachedResultSchema>;

type CacheShape = z.infer<typeof cacheShapeSchema>;

function readCache(): CacheShape {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = cacheShapeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeCache(cache: CacheShape): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Quota exceeded or storage disabled — silently degrade. The button
    // will simply behave as it did before the cache existed.
  }
}

/**
 * Read a cached result for a provider id. Returns `null` if absent or
 * expired. Expired entries are purged on read so the cache doesn't grow
 * unboundedly across long sessions.
 */
export function getCachedTestResult(providerId: string): CachedProviderTestResult | null {
  const cache = readCache();
  const entry = cache[providerId];
  if (!entry) return null;
  if (typeof entry.testedAt !== 'number' || Date.now() - entry.testedAt > TTL_MS) {
    delete cache[providerId];
    writeCache(cache);
    return null;
  }
  return entry;
}

export function setCachedTestResult(
  providerId: string,
  result: { ok: boolean; modelCount: number }
): void {
  const cache = readCache();
  cache[providerId] = {
    ok: result.ok,
    modelCount: result.modelCount,
    testedAt: Date.now(),
  };
  writeCache(cache);
}

/** Drop a single provider's cached result — call after mutating that provider. */
export function clearCachedTestResult(providerId: string): void {
  const cache = readCache();
  if (!(providerId in cache)) return;
  delete cache[providerId];
  writeCache(cache);
}

/** Drop the entire cache — exposed mainly for tests. */
export function clearAllCachedTestResults(): void {
  writeCache({});
}
