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
 * value names a credential row that is live — not revoked, expired or
 * deactivated, and (for embed tokens and MCP keys) able to enter its org.
 * Scopes and origin checks stay with the route's own resolver
 * (`resolveApiKey`, `authenticateMcpRequest`, `resolveEmbedToken`), which
 * runs after this and still refuses a bad credential.
 *
 * Cost:
 * - A verified credential is cached for {@link VERIFIED_TTL_MS} (never past
 *   its own expiry). In the second half of that window the cached id is still
 *   served and a re-check runs in the background, so a credential in steady
 *   use is never looked up on the request path.
 * - A value with no cached verification ("cold") is looked up only while the
 *   caller's IP has room in a separate lookup budget
 *   ({@link LOOKUPS_PER_IP_PER_MINUTE}). The budget is reserved before the
 *   query runs, so concurrent requests cannot race past it. A cold value over
 *   budget is keyed on the IP. The trade-off, chosen on purpose: a real
 *   credential that is cold when its IP has spent the lookup budget shares the
 *   IP bucket until the budget frees up — the request bucket filling no longer
 *   affects it, only lookups do.
 * - Concurrent checks of one credential share one query.
 *
 * Tenancy posture: row-keyed — a digest of the presented credential maps to
 * the stored row's id, both unique across orgs; see `lib/tenancy/process-state.ts`.
 *
 * @see lib/security/rate-limit-middleware.ts — the consumer
 */

import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { API_KEY_PREFIX, hashApiKey } from '@/lib/auth/api-keys';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { MCP_API_KEY_PREFIX, hashApiKey as hashMcpApiKey } from '@/lib/orchestration/mcp/auth';
import { SECURITY_CONSTANTS } from '@/lib/security/constants';
import { createRateLimiter } from '@/lib/security/rate-limit';
import { runAsCredentialLookup } from '@/lib/tenancy/context';
import { resolveCredentialOrg } from '@/lib/tenancy/entry';

/** The two built-in key strategies that identify a caller by a credential. */
export type RateLimitCredentialKind = 'api-key' | 'embed-token';

/** How long a verified credential keeps its own bucket before it must be re-checked. */
const VERIFIED_TTL_MS = 60_000;

/** A cached entry with less than this left is re-checked in the background. */
const REFRESH_BELOW_MS = VERIFIED_TTL_MS / 2;

/**
 * How long after its last successful check a failing re-check may keep
 * re-arming an entry. Past this, a database outage lets the entry lapse.
 */
const MAX_REARM_AGE_MS = 2 * VERIFIED_TTL_MS;

/** Upper bound on cached verified credentials (per process). */
const MAX_VERIFIED_CREDENTIALS = 1000;

/** Lookups of cold values one client IP may cause per minute. */
const LOOKUPS_PER_IP_PER_MINUTE = 30;

/** A live credential's bucket id and, when it has one, its expiry. */
interface LiveCredential {
  id: string;
  expiresAt: Date | null;
}

/**
 * A cached verification. `capped` when its TTL was cut short by the
 * credential's expiry; `verifiedAt` is the last successful check.
 */
interface CachedEntry extends LiveCredential {
  capped: boolean;
  verifiedAt: number;
}

// Keyed on a digest of the presented value so the raw credential is never
// held as a cache key; the value holds the stable id the bucket is keyed on.
const verified = new LRUCache<string, CachedEntry>({
  max: MAX_VERIFIED_CREDENTIALS,
  ttl: VERIFIED_TTL_MS,
});

// Lookups in progress, by the same digest, so the requests that check one
// credential at the same moment share a single query. An entry lives only
// until its lookup settles.
const inFlight = new Map<string, Promise<string | null>>();

// The per-IP budget for looking up cold values — separate from the request
// buckets, and reserved synchronously before the query.
const lookupBudget = createRateLimiter({
  interval: SECURITY_CONSTANTS.RATE_LIMIT.DEFAULT_INTERVAL,
  maxRequests: LOOKUPS_PER_IP_PER_MINUTE,
  uniqueTokenPerInterval: SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
});

function cacheKey(kind: RateLimitCredentialKind, value: string): string {
  return createHash('sha256').update(`${kind}:${value}`).digest('hex');
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
        select: {
          id: true,
          isActive: true,
          orgId: true,
          agent: { select: { isActive: true } },
          org: { select: { status: true } },
        },
      })
    );
    if (!row?.isActive || !row.agent.isActive) return null;
    const entry = resolveCredentialOrg(
      { orgId: row.orgId, orgStatus: row.org?.status ?? null },
      'embed-token'
    );
    return 'refused' in entry ? null : live(row.id, null);
  }

  // Each key type is hashed by its own resolver's function and recognised by
  // its issuer's prefix, so a change to either reaches this lookup too.
  if (value.startsWith(API_KEY_PREFIX)) {
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
        select: {
          id: true,
          isActive: true,
          expiresAt: true,
          orgId: true,
          org: { select: { status: true } },
        },
      })
    );
    if (!row?.isActive) return null;
    const entry = resolveCredentialOrg(
      { orgId: row.orgId, orgStatus: row.org?.status ?? null },
      'mcp-key'
    );
    return 'refused' in entry ? null : live(`mcp:${row.id}`, row.expiresAt);
  }
  // Not a credential format Sunrise issues: nothing to look up.
  return null;
}

function cacheLive(key: string, found: LiveCredential | null, verifiedAt: number): void {
  if (!found) {
    verified.delete(key);
    return;
  }
  // Never keep a key's bucket past the key's own expiry (and never pass 0,
  // which lru-cache reads as "no TTL").
  const untilExpiry = found.expiresAt ? found.expiresAt.getTime() - Date.now() : Infinity;
  const capped = untilExpiry < VERIFIED_TTL_MS;
  const ttl = capped ? Math.max(1, untilExpiry) : VERIFIED_TTL_MS;
  verified.set(key, { ...found, capped, verifiedAt }, { ttl });
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
    // refresh window rather than on every request — never past the
    // credential's expiry, and only while its last good check is recent.
    const cached = verified.get(key);
    if (cached && Date.now() - cached.verifiedAt < MAX_REARM_AGE_MS) {
      cacheLive(key, live(cached.id, cached.expiresAt), cached.verifiedAt);
    }
    throw error;
  }
  cacheLive(key, found, Date.now());
  return found?.id ?? null;
}

/** Run (or join) the one lookup in flight for this credential. */
function verifyShared(
  key: string,
  kind: RateLimitCredentialKind,
  value: string
): Promise<string | null> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = verifyAndCache(key, kind, value).finally(() => {
    // Only remove our own entry; a reset may have let a newer lookup in.
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

function warnLookupFailed(kind: RateLimitCredentialKind, error: unknown): void {
  logger.warn('rate-limit credentials: lookup failed', {
    key: kind,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * The stable bucket id for the credential a request presents, or `null` to
 * key the request on the client IP. See the module docblock for what this
 * costs and when it falls back. Never throws: a failed lookup is logged and
 * answers `null` (the cached id, when one is being served, is unaffected).
 */
export async function resolveRateLimitCredential(
  kind: RateLimitCredentialKind,
  value: string,
  ip: string
): Promise<string | null> {
  const key = cacheKey(kind, value);

  const cached = verified.get(key);
  if (cached) {
    // An entry capped at the credential's expiry is never refreshed: it ends
    // when the credential does, and a re-check could not extend it.
    if (!cached.capped && verified.getRemainingTTL(key) < REFRESH_BELOW_MS) {
      verifyShared(key, kind, value).catch((error: unknown) => warnLookupFailed(kind, error));
    }
    return cached.id;
  }

  // A lookup already running for this value costs nothing more to join.
  const pending = inFlight.get(key);
  if (!pending && !lookupBudget.check(`ip:${ip}`).success) return null;
  try {
    return await (pending ?? verifyShared(key, kind, value));
  } catch (error) {
    warnLookupFailed(kind, error);
    return null;
  }
}

/** Test-only: drop every cached verification and lookup in flight. */
export function resetRateLimitCredentialCache(): void {
  verified.clear();
  inFlight.clear();
}

/** Test-only: clear one IP's cold-lookup budget. */
export function resetRateLimitCredentialBudget(ip: string): void {
  lookupBudget.reset(`ip:${ip}`);
}
