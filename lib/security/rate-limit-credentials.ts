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

function isExpired(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt < new Date();
}

async function lookup(kind: RateLimitCredentialKind, value: string): Promise<string | null> {
  if (kind === 'embed-token') {
    const row = await runAsCredentialLookup('embed-token', () =>
      prisma.aiAgentEmbedToken.findUnique({
        where: { token: value },
        select: { id: true, isActive: true, agent: { select: { isActive: true } } },
      })
    );
    return row?.isActive && row.agent.isActive ? row.id : null;
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
    return row && !isExpired(row.expiresAt) ? `sk:${row.id}` : null;
  }
  if (value.startsWith(MCP_API_KEY_PREFIX)) {
    const row = await runAsCredentialLookup('mcp-key', () =>
      prisma.mcpApiKey.findUnique({
        where: { keyHash: hashMcpApiKey(value) },
        select: { id: true, isActive: true, expiresAt: true },
      })
    );
    return row?.isActive && !isExpired(row.expiresAt) ? `mcp:${row.id}` : null;
  }
  // Not a credential format Sunrise issues: nothing to look up.
  return null;
}

/**
 * Look the credential up and return a stable id for its bucket, or `null`
 * when the value names no live credential. A verified id is cached for
 * {@link VERIFIED_TTL_MS}; a credential that no longer verifies (revoked,
 * expired, deactivated) loses its cached entry. Throws if the lookup itself
 * fails, leaving the cache as it was.
 */
export async function verifyRateLimitCredential(
  kind: RateLimitCredentialKind,
  value: string
): Promise<string | null> {
  const id = await lookup(kind, value);
  const key = cacheKey(kind, value);
  if (id) verified.set(key, id);
  else verified.delete(key);
  return id;
}

/** Test-only: drop every cached verification. */
export function resetRateLimitCredentialCache(): void {
  verified.clear();
}
