/**
 * Verified Rate-Limit Credentials
 *
 * The `'api-key'` and `'embed-token'` key strategies in
 * `lib/security/rate-limit-middleware.ts` give a caller its own bucket only
 * when the credential it presents exists. A header value is chosen by the
 * caller, so keying on it as presented would let every request open a fresh
 * bucket (#701). This module answers "which stored credential is this?" and
 * the middleware keys on that answer, or on the client IP when there is none.
 *
 * The question here is narrower than authentication: it only asks whether the
 * value names a credential row that is live (not revoked, expired or
 * deactivated). Scopes, org entry and origin checks stay with the route's own
 * resolver (`resolveApiKey`, `authenticateMcpRequest`, `resolveEmbedToken`),
 * which runs after this and still refuses a bad credential.
 *
 * Positive answers are cached for a short TTL and refreshed in the second
 * half of it, so a legitimate caller costs about one lookup per half-TTL, not
 * one per request. Only positive answers are cached: a caller presenting a
 * value that verifies to nothing lands in its IP bucket, and the middleware
 * skips the lookup once that bucket is full, so the lookups such a caller can
 * cause are bounded by the IP cap.
 *
 * Tenancy posture: row-keyed — a digest of the presented credential maps to
 * the stored row's id, both unique across orgs; see `lib/tenancy/process-state.ts`.
 *
 * @see lib/security/rate-limit-middleware.ts — the consumer
 */

import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { hashApiKey } from '@/lib/auth/api-keys';
import { prisma } from '@/lib/db/client';
import { hashApiKey as hashMcpApiKey } from '@/lib/orchestration/mcp/auth';
import { runAsCredentialLookup } from '@/lib/tenancy/context';

/** The two built-in key strategies that identify a caller by a credential. */
export type RateLimitCredentialKind = 'api-key' | 'embed-token';

/** How long a verified credential keeps its own bucket before it must be re-checked. */
const VERIFIED_TTL_MS = 60_000;

/**
 * A cached entry with less than this left is re-checked on its next use, so a
 * credential in steady use is refreshed before it expires and never has to
 * pass the middleware's IP-bucket gate for unknown values again.
 */
const REFRESH_BELOW_MS = VERIFIED_TTL_MS / 2;

/** Upper bound on cached verified credentials (per process). */
const MAX_VERIFIED_CREDENTIALS = 1000;

/** Prefix of a user/admin API key (`lib/auth/api-keys.ts`). */
const USER_API_KEY_PREFIX = 'sk_';

/** Prefix of an MCP API key (`lib/orchestration/mcp/auth.ts`). */
const MCP_API_KEY_PREFIX = 'smcp_';

// Keyed on a digest of the presented value so the raw credential is never
// held as a cache key; the value is the stable id the bucket is keyed on.
const verified = new LRUCache<string, string>({
  max: MAX_VERIFIED_CREDENTIALS,
  ttl: VERIFIED_TTL_MS,
});

// Lookups in progress, by the same digest, so the requests that find one
// credential due a re-check at the same moment share a single query. An entry
// lives only until its lookup settles.
const inFlight = new Map<string, Promise<string | null>>();

function cacheKey(kind: RateLimitCredentialKind, value: string): string {
  return createHash('sha256').update(`${kind}:${value}`).digest('hex');
}

/** A cached verification: the bucket id, and whether it is due a re-check. */
export interface CachedRateLimitCredential {
  id: string;
  stale: boolean;
}

/**
 * The cached id for a credential verified within the TTL, or `undefined` when
 * it has not been verified (or its entry expired). `stale` marks an entry in
 * the second half of its TTL, which the caller should re-verify. Never touches
 * the database.
 */
export function getCachedRateLimitCredential(
  kind: RateLimitCredentialKind,
  value: string
): CachedRateLimitCredential | undefined {
  const key = cacheKey(kind, value);
  const id = verified.get(key);
  if (!id) return undefined;
  return { id, stale: verified.getRemainingTTL(key) < REFRESH_BELOW_MS };
}

/** A live credential's bucket id and, when it has one, its expiry. */
interface LiveCredential {
  id: string;
  expiresAt: Date | null;
}

function live(id: string, expiresAt: Date | null): LiveCredential | null {
  return expiresAt === null || expiresAt > new Date() ? { id, expiresAt } : null;
}

async function lookup(
  kind: RateLimitCredentialKind,
  value: string
): Promise<LiveCredential | null> {
  if (kind === 'embed-token') {
    const row = await runAsCredentialLookup('embed-token', () =>
      prisma.aiAgentEmbedToken.findUnique({
        where: { token: value },
        select: { id: true, isActive: true, agent: { select: { isActive: true } } },
      })
    );
    return row?.isActive && row.agent.isActive ? live(row.id, null) : null;
  }

  // Each key type is hashed by its own resolver's function, so a change to
  // how one is stored reaches this lookup too.
  if (value.startsWith(USER_API_KEY_PREFIX)) {
    const row = await runAsCredentialLookup('api-key', () =>
      prisma.aiApiKey.findFirst({
        where: { keyHash: hashApiKey(value), revokedAt: null },
        select: { id: true, expiresAt: true },
      })
    );
    return row ? live(`sk:${row.id}`, row.expiresAt) : null;
  }
  if (value.startsWith(MCP_API_KEY_PREFIX)) {
    const row = await runAsCredentialLookup('mcp-key', () =>
      prisma.mcpApiKey.findUnique({
        where: { keyHash: hashMcpApiKey(value) },
        select: { id: true, isActive: true, expiresAt: true },
      })
    );
    return row?.isActive ? live(`mcp:${row.id}`, row.expiresAt) : null;
  }
  // Not a credential format Sunrise issues: nothing to look up.
  return null;
}

async function verifyAndCache(
  key: string,
  kind: RateLimitCredentialKind,
  value: string
): Promise<string | null> {
  let found: LiveCredential | null;
  try {
    found = await lookup(kind, value);
  } catch (error) {
    // Re-arm a cached entry so a failing database is retried once per
    // refresh window rather than on every request that finds it stale.
    const cached = verified.get(key);
    if (cached) verified.set(key, cached);
    throw error;
  }
  if (!found) {
    verified.delete(key);
    return null;
  }
  // Never keep a key's bucket past the key's own expiry (and never pass 0,
  // which lru-cache reads as "no TTL").
  const ttl = found.expiresAt
    ? Math.max(1, Math.min(VERIFIED_TTL_MS, found.expiresAt.getTime() - Date.now()))
    : VERIFIED_TTL_MS;
  verified.set(key, found.id, { ttl });
  return found.id;
}

/**
 * Look the credential up and return a stable id for its bucket, or `null`
 * when the value names no live credential. A verified id is cached for
 * {@link VERIFIED_TTL_MS}, or until the credential expires if that is sooner;
 * a credential that no longer verifies (revoked, expired, deactivated) loses
 * its cached entry. Concurrent calls for one credential share one lookup.
 * Throws if the lookup itself fails, re-arming any cached entry.
 */
export function verifyRateLimitCredential(
  kind: RateLimitCredentialKind,
  value: string
): Promise<string | null> {
  const key = cacheKey(kind, value);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = verifyAndCache(key, kind, value).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** Test-only: drop every cached verification. */
export function resetRateLimitCredentialCache(): void {
  verified.clear();
  inFlight.clear();
}
