/**
 * A user's own API keys: list, mint, revoke (#1132).
 *
 * The self-service routes (`/api/v1/user/api-keys`) run in the org the request
 * entered. A key bound to an org lives in that org, so the request's own scope
 * reads and writes it. A platform key (`admin` scope, `orgId` NULL, §106) lives
 * in no org, and at `TENANCY_MODE=multi` the `ai_api_key` isolation policy
 * admits a row only when its `orgId` equals the entered org, so from any org a
 * NULL row can be neither written nor seen: minting one answered 500, and list
 * and revoke could not find it.
 *
 * So each operation on a platform key runs under {@link runAsSystem}, and is
 * narrowed by hand to the caller's own row: `userId` and `orgId: null` in every
 * filter. The bypass widens what the database lets through, never whose keys
 * are touched. Adding a platform-row arm to the policy instead was rejected in
 * #1132: every org-scoped read of `ai_api_key` would then see every platform
 * key.
 *
 * At `single` the policy is dormant and the system scope changes nothing.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { runAsSystem } from '@/lib/tenancy/context';

/** The fields a key is listed and minted with; never the hash. */
const KEY_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  orgId: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} satisfies Prisma.AiApiKeySelect;

export type UserApiKey = Prisma.AiApiKeyGetPayload<{ select: typeof KEY_SELECT }>;

/**
 * The caller's keys: those bound to the entered org, and their platform keys,
 * newest first. Keys bound to another org are not listed, as before: they act
 * only there (§106).
 */
export async function listUserApiKeys(userId: string): Promise<UserApiKey[]> {
  const [bound, platform] = await Promise.all([
    prisma.aiApiKey.findMany({
      where: { userId, orgId: { not: null } },
      select: KEY_SELECT,
    }),
    runAsSystem('api-keys: list the caller’s own platform keys', () =>
      prisma.aiApiKey.findMany({ where: { userId, orgId: null }, select: KEY_SELECT })
    ),
  ]);
  return [...bound, ...platform].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export interface MintUserApiKeyInput {
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  /** The org the key binds, or null for a platform key. The route decides which. */
  orgId: string | null;
}

/** Store a key the route has already authorised. A platform key is written outside every org. */
export async function mintUserApiKey(
  input: MintUserApiKeyInput
): Promise<Omit<UserApiKey, 'lastUsedAt' | 'revokedAt'>> {
  const select = { ...KEY_SELECT, lastUsedAt: false, revokedAt: false } as const;
  const create = () => prisma.aiApiKey.create({ data: input, select });
  return input.orgId === null
    ? runAsSystem('api-keys: mint a platform admin key', create)
    : create();
}

export type RevokeOutcome = 'revoked' | 'already-revoked' | 'not-found';

/**
 * Revoke one of the caller's keys: bound to the entered org, or a platform key
 * of theirs. Another user's key, or one bound to another org, is not found.
 */
export async function revokeUserApiKey(userId: string, keyId: string): Promise<RevokeOutcome> {
  const bound = await prisma.aiApiKey.findFirst({
    where: { id: keyId, userId, orgId: { not: null } },
    select: { id: true, revokedAt: true },
  });
  if (bound) {
    if (bound.revokedAt) return 'already-revoked';
    await prisma.aiApiKey.update({ where: { id: bound.id }, data: { revokedAt: new Date() } });
    return 'revoked';
  }

  return runAsSystem('api-keys: revoke the caller’s own platform key', async () => {
    const platform = await prisma.aiApiKey.findFirst({
      where: { id: keyId, userId, orgId: null },
      select: { id: true, revokedAt: true },
    });
    if (!platform) return 'not-found';
    if (platform.revokedAt) return 'already-revoked';
    // Narrowed again in the write, not only the read: under the bypass the
    // filter is the only thing keeping this to the caller's platform key.
    await prisma.aiApiKey.updateMany({
      where: { id: platform.id, userId, orgId: null },
      data: { revokedAt: new Date() },
    });
    return 'revoked';
  });
}
