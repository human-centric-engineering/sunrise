/**
 * API Key utilities
 *
 * Handles API key generation, hashing, and validation.
 * Keys are never stored in plaintext — only the SHA-256 hash is persisted.
 * The raw key is returned exactly once at creation time.
 *
 * Key format: `sk_<32 random hex chars>` (e.g. sk_a1b2c3d4...)
 * Stored prefix: first 8 chars (e.g. `sk_a1b2c`) for display/identification.
 */

import { randomBytes, createHash } from 'crypto';
import { prisma } from '@/lib/db/client';
import type { NextRequest } from 'next/server';
import type { AuthSession } from '@/lib/auth/guards';
export {
  CORE_API_KEY_SCOPES,
  listValidApiKeyScopes,
  validateScopes,
  hasScope,
  type CoreApiKeyScope,
  type ApiKeyScope,
} from '@/lib/auth/api-key-scopes';

/**
 * Prefix on the synthetic `session.id` that `resolveApiKey` mints, so an
 * API-key principal is distinguishable from a real cookie session downstream.
 */
export const API_KEY_SESSION_ID_PREFIX = 'apikey_';

/**
 * True when this principal authenticated with an API key rather than a browser
 * session.
 *
 * `withAuth` accepts an API key of **any** scope and hands the handler a
 * session-shaped object, so a route cannot tell the two apart without asking.
 * That is fine for reading data, and wrong for anything that mutates identity:
 * API keys are self-service (`POST /api/v1/user/api-keys`) and a scope like
 * `chat` is meant to convey "talk to my agents", not "change my email address".
 *
 * Use this to refuse identity-mutating operations to key-authenticated callers.
 * See `PATCH /api/v1/users/me`.
 */
export function isApiKeySession(session: AuthSession): boolean {
  return session.session.id.startsWith(API_KEY_SESSION_ID_PREFIX);
}

/** Generate a new API key string. */
export function generateApiKey(): string {
  const random = randomBytes(32).toString('hex');
  return `sk_${random}`;
}

/** Hash an API key with SHA-256. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Extract the display prefix from a key (first 8 chars + ...). */
export function keyPrefix(key: string): string {
  return key.slice(0, 8);
}

/**
 * Resolve an API key from the Authorization header.
 *
 * Expects: `Authorization: Bearer sk_...`
 *
 * Returns the user session-like object if the key is valid,
 * or null if the key is missing/invalid/revoked/expired.
 */
export async function resolveApiKey(request: NextRequest): Promise<{
  session: AuthSession;
  scopes: string[];
  rateLimitRpm: number | null;
  /**
   * The org the key was minted in (§106) — `null` for a platform (`admin`)
   * credential. The guards enter it; see `lib/tenancy/entry.ts` for the
   * read rule, including what a `null` on a non-admin key means.
   * Optional in the type so a test double built before the org axis still
   * compiles; the guard reads a missing value as `null`.
   */
  orgId?: string | null;
  /** The owner's account type, for the install-org role rule at `single`. */
  ownerAccountType?: string | null;
} | null> {
  // Defensive: tolerate requests without a populated headers map. Test
  // harnesses sometimes pass a stub `{} as NextRequest`; without the
  // optional chain we'd throw before the cookie-session path could run,
  // turning a pre-Phase-4 401/400 into a 500.
  const authHeader = request.headers?.get('authorization');
  if (!authHeader?.startsWith('Bearer sk_')) return null;

  const rawKey = authHeader.slice('Bearer '.length);
  const hash = hashApiKey(rawKey);

  const apiKey = await prisma.aiApiKey.findFirst({
    where: {
      keyHash: hash,
      revokedAt: null,
    },
    include: {
      user: true,
    },
  });

  if (!apiKey) return null;

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;

  // Update last used timestamp (fire-and-forget)
  void prisma.aiApiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  });

  // Build a session-like object from the API key's user
  const session: AuthSession = {
    session: {
      id: `${API_KEY_SESSION_ID_PREFIX}${apiKey.id}`,
      userId: apiKey.userId,
      token: '',
      expiresAt: apiKey.expiresAt ?? new Date(Date.now() + 86400000),
      createdAt: apiKey.createdAt,
      updatedAt: apiKey.createdAt,
    },
    user: {
      id: apiKey.user.id,
      name: apiKey.user.name,
      email: apiKey.user.email,
      emailVerified: apiKey.user.emailVerified,
      image: apiKey.user.image,
      role: apiKey.user.role,
      createdAt: apiKey.user.createdAt,
      updatedAt: apiKey.user.updatedAt,
    },
  };

  return {
    session,
    scopes: apiKey.scopes,
    rateLimitRpm: apiKey.rateLimitRpm,
    orgId: apiKey.orgId,
    ownerAccountType: apiKey.user.accountType,
  };
}
