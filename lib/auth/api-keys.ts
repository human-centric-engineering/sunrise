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

/** Valid API key scopes. */
export type ApiKeyScope = 'chat' | 'analytics' | 'knowledge' | 'webhook' | 'admin';

const VALID_SCOPES = new Set<ApiKeyScope>(['chat', 'analytics', 'knowledge', 'webhook', 'admin']);

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

/** Validate that scopes are all valid. */
export function validateScopes(scopes: string[]): scopes is ApiKeyScope[] {
  return scopes.every((s) => VALID_SCOPES.has(s as ApiKeyScope));
}

/**
 * Resolve an API key from the Authorization header.
 *
 * Expects: `Authorization: Bearer sk_...`
 *
 * Returns the user session-like object if the key is valid,
 * or null if the key is missing/invalid/revoked/expired.
 */
export async function resolveApiKey(
  request: NextRequest
): Promise<{ session: AuthSession; scopes: string[]; rateLimitRpm: number | null } | null> {
  const authHeader = request.headers.get('authorization');
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
      id: `apikey_${apiKey.id}`,
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

  return { session, scopes: apiKey.scopes, rateLimitRpm: apiKey.rateLimitRpm };
}

/**
 * Check if the provided scopes include the required scope.
 */
export function hasScope(scopes: string[], required: ApiKeyScope): boolean {
  return scopes.includes(required) || scopes.includes('admin');
}
