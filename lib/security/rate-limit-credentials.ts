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
 * value names a credential row that is still live. Scopes, org entry, origin
 * checks and expiry stay with the route's own resolver (`resolveApiKey`,
 * `authenticateMcpRequest`, `resolveEmbedToken`), which runs after this and
 * still refuses a bad credential.
 *
 * Positive answers are cached for a short TTL so a legitimate caller costs one
 * lookup per TTL, not one per request. Only positive answers are cached: a
 * caller presenting a value that verifies to nothing lands in its IP bucket,
 * and the middleware skips the lookup once that bucket is full, so the
 * lookups such a caller can cause are bounded by the IP cap.
 *
 * Tenancy posture: row-keyed — a digest of the presented credential maps to
 * the stored row's id, both unique across orgs; see `lib/tenancy/process-state.ts`.
 *
 * @see lib/security/rate-limit-middleware.ts — the consumer
 */

import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { prisma } from '@/lib/db/client';
import { runAsCredentialLookup } from '@/lib/tenancy/context';

/** The two built-in key strategies that identify a caller by a credential. */
export type RateLimitCredentialKind = 'api-key' | 'embed-token';

/** How long a verified credential keeps its own bucket before it is re-checked. */
const VERIFIED_TTL_MS = 60_000;

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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cacheKey(kind: RateLimitCredentialKind, value: string): string {
  return sha256(`${kind}:${value}`);
}

/**
 * The cached id for a credential verified within the TTL, or `undefined` when
 * it has not been verified (or its entry expired). Never touches the database.
 */
export function getCachedRateLimitCredential(
  kind: RateLimitCredentialKind,
  value: string
): string | undefined {
  return verified.get(cacheKey(kind, value));
}

async function lookup(kind: RateLimitCredentialKind, value: string): Promise<string | null> {
  if (kind === 'embed-token') {
    const row = await runAsCredentialLookup('embed-token', () =>
      prisma.aiAgentEmbedToken.findUnique({
        where: { token: value },
        select: { id: true, isActive: true },
      })
    );
    return row?.isActive ? row.id : null;
  }

  // The stored column is the SHA-256 of the key, as the two resolvers hash it.
  if (value.startsWith(USER_API_KEY_PREFIX)) {
    const row = await runAsCredentialLookup('api-key', () =>
      prisma.aiApiKey.findFirst({
        where: { keyHash: sha256(value), revokedAt: null },
        select: { id: true },
      })
    );
    return row ? `sk:${row.id}` : null;
  }
  if (value.startsWith(MCP_API_KEY_PREFIX)) {
    const row = await runAsCredentialLookup('mcp-key', () =>
      prisma.mcpApiKey.findUnique({
        where: { keyHash: sha256(value) },
        select: { id: true, isActive: true },
      })
    );
    return row?.isActive ? `mcp:${row.id}` : null;
  }
  // Not a credential format Sunrise issues: nothing to look up.
  return null;
}

/**
 * Look the credential up and return a stable id for its bucket, or `null`
 * when the value names no live credential. A verified id is cached for
 * {@link VERIFIED_TTL_MS}. Throws if the lookup itself fails; the caller
 * falls back to the IP bucket.
 */
export async function verifyRateLimitCredential(
  kind: RateLimitCredentialKind,
  value: string
): Promise<string | null> {
  const id = await lookup(kind, value);
  if (id) verified.set(cacheKey(kind, value), id);
  return id;
}

/** Test-only: drop every cached verification. */
export function resetRateLimitCredentialCache(): void {
  verified.clear();
}
