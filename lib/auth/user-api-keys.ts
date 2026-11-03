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
 * So at `multi` each operation on a platform key runs under
 * {@link runAsSystem}, narrowed by hand to the caller's own row: `userId` and
 * `orgId: null` in every filter. The bypass widens what the database lets
 * through, never whose keys are touched. Adding a platform-row arm to the
 * policy instead was rejected in #1132: every org-scoped read of `ai_api_key`
 * would then see every platform key.
 *
 * **Only from a browser session in the install org**, as the mint route
 * already requires: that is where the screen and the credential agree. Any
 * other caller (a session in a customer org, or any API key, wherever it is
 * bound) sees and revokes the keys of the org it entered and none of the
 * owner's platform keys, so a leaked key cannot list its owner's `admin`
 * credentials.
 *
 * At `single` the policy is dormant and there is one org, so every operation
 * is the one query it always was.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { getTenantContext, isMultiTenant, runAsSystem } from '@/lib/tenancy/context';

/** The fields a key is listed with; never the hash. */
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

/** The fields a mint returns. */
const MINT_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  orgId: true,
  expiresAt: true,
  createdAt: true,
} satisfies Prisma.AiApiKeySelect;

const NEWEST_FIRST = { createdAt: 'desc' } as const;

export type UserApiKey = Prisma.AiApiKeyGetPayload<{ select: typeof KEY_SELECT }>;
export type MintedUserApiKey = Prisma.AiApiKeyGetPayload<{ select: typeof MINT_SELECT }>;

/**
 * Whether this request is a person's browser session acting in the install
 * org, where platform keys are managed. A key never counts, even one bound to
 * the install org: a leaked narrow key must not list its owner's `admin`
 * credentials. Nor does a support session (§121).
 */
function managesPlatformKeys(): boolean {
  const ctx = getTenantContext();
  return ctx?.orgId === INSTALL_ORG_ID && (ctx.source === 'session' || ctx.source === 'resolver');
}

/**
 * The caller's keys, newest first: those bound to the entered org, and, from
 * the install org, their platform keys. Keys bound to another org are listed
 * from that org: they act only there (§106).
 */
export async function listUserApiKeys(userId: string): Promise<UserApiKey[]> {
  if (!isMultiTenant()) {
    return prisma.aiApiKey.findMany({
      where: { userId },
      orderBy: NEWEST_FIRST,
      select: KEY_SELECT,
    });
  }
  // No org entered (an admin API key enters none): no org-bound key to list,
  // and the read would be refused for want of a context.
  const bound =
    getTenantContext() === null
      ? Promise.resolve([])
      : prisma.aiApiKey.findMany({
          where: { userId, orgId: { not: null } },
          orderBy: NEWEST_FIRST,
          select: KEY_SELECT,
        });
  if (!managesPlatformKeys()) return bound;
  const [inOrg, platform] = await Promise.all([
    bound,
    runAsSystem('api-keys: list the caller’s own platform keys', () =>
      prisma.aiApiKey.findMany({
        where: { userId, orgId: null },
        orderBy: NEWEST_FIRST,
        select: KEY_SELECT,
      })
    ),
  ]);
  return [...inOrg, ...platform].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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

/**
 * Store a key the route has already authorised. A platform key is written
 * outside every org at `multi`; only an `admin` key may bind no org (§106).
 */
export async function mintUserApiKey(input: MintUserApiKeyInput): Promise<MintedUserApiKey> {
  if (input.orgId === null && !input.scopes.includes('admin')) {
    // The state the §106 backfill removed: a non-admin key no org can see.
    throw new Error('Only an admin-scoped key may be minted without an org');
  }
  // The known fields only: a wider object passed in must not reach `data`.
  const { userId, name, keyHash, keyPrefix, scopes, expiresAt, orgId } = input;
  const create = () =>
    prisma.aiApiKey.create({
      data: { userId, name, keyHash, keyPrefix, scopes, expiresAt, orgId },
      select: MINT_SELECT,
    });
  return input.orgId === null && isMultiTenant()
    ? runAsSystem('api-keys: mint a platform admin key', create)
    : create();
}

export type RevokeOutcome = 'revoked' | 'already-revoked' | 'not-found';

/**
 * Revoke the one row `where` names, if it is not already revoked. One
 * conditional write, so concurrent revokes cannot both report it or move the
 * recorded time; the read after only tells "already revoked" from "not yours".
 */
async function revokeWhere(where: Prisma.AiApiKeyWhereInput): Promise<RevokeOutcome> {
  const { count } = await prisma.aiApiKey.updateMany({
    where: { ...where, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count > 0) return 'revoked';
  const exists = await prisma.aiApiKey.findFirst({ where, select: { id: true } });
  return exists ? 'already-revoked' : 'not-found';
}

/**
 * Revoke one of the caller's keys: bound to the entered org, or, from the
 * install org, a platform key of theirs. Another user's key, or one bound to
 * another org, is not found.
 */
export async function revokeUserApiKey(userId: string, keyId: string): Promise<RevokeOutcome> {
  if (!isMultiTenant()) return revokeWhere({ id: keyId, userId });

  // No org entered: no org-bound key to reach (and the read would be refused).
  const bound =
    getTenantContext() === null
      ? 'not-found'
      : await revokeWhere({ id: keyId, userId, orgId: { not: null } });
  if (bound !== 'not-found' || !managesPlatformKeys()) return bound;
  // Under the bypass the filter is the only fence: the caller's platform row.
  return runAsSystem('api-keys: revoke the caller’s own platform key', () =>
    revokeWhere({ id: keyId, userId, orgId: null })
  );
}
