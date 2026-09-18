/**
 * Agent invite tokens — resolving and consuming one (§106 t-673).
 *
 * An `invite_only` agent admits a caller who presents a token minted for
 * it. Two routes ask the same question — `POST /api/v1/chat/stream` before
 * it streams, `POST /api/v1/chat/agents/[slug]/validate-token` so a widget
 * can ask first — and until t-673 each carried its own copy of the checks.
 * This is the one implementation; each route keeps its own mapping of the
 * outcome to a response (a 403 that names little, or `{ valid, reason }`).
 *
 * **An invite token is a gate the session passes through, not a credential
 * that acts.** The caller is a signed-in user whose org the guard already
 * entered; the token is minted in an org and admits callers acting in that
 * org. So it never enters a tenant context of its own — unlike an embed
 * token or an MCP key, whose resolvers answer an org for `runAsOrg` — and
 * the org check here is a comparison: the token's org against the org of
 * the request. A token from another org is `wrong-org`, which the routes
 * present as not found: nothing enumerates.
 *
 * A token whose `orgId` is still null (minted before the column was
 * written) reads as the install org at `single` and matches no org at
 * `multi` — `orgOfColumn`, the same rule every credential follows.
 *
 * **A request acting in no org passes no gate.** At `multi` an
 * `admin`-scoped API key enters no org (it is the platform credential), so
 * from it every token is `wrong-org` — including a live one. That is
 * deliberate: an invite token admits members of the org it was minted in,
 * and a platform key is not a member of anything; the consumer chat surface
 * is reached with a session or an org-bound key. It is logged with its own
 * reason so an operator whose automation key stopped passing a gate can see
 * the cause is the key, not the token.
 */
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getTenantContext } from '@/lib/tenancy/context';
import { orgOfColumn } from '@/lib/tenancy/entry';

/** Why a token does not admit this request. */
export type InviteTokenRefusal = 'not-found' | 'wrong-org' | 'revoked' | 'expired' | 'exhausted';

export interface InviteTokenRow {
  id: string;
  orgId: string | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
}

export type InviteTokenOutcome =
  { ok: true; token: InviteTokenRow } | { ok: false; reason: InviteTokenRefusal };

/**
 * Resolve `token` for `agentId` against the org the current request acts
 * in. Read-only: a token that passes is not yet used — `consumeInviteToken`
 * is the write, kept separate because the validate route must not spend a
 * use to answer a question.
 */
export async function resolveInviteToken(
  agentId: string,
  token: string
): Promise<InviteTokenOutcome> {
  const row = await prisma.aiAgentInviteToken.findFirst({
    where: { agentId, token },
    select: {
      id: true,
      orgId: true,
      revokedAt: true,
      expiresAt: true,
      maxUses: true,
      useCount: true,
    },
  });
  if (!row) return { ok: false, reason: 'not-found' };

  // The org check comes first: a token from another org is not this
  // caller's to learn anything about, revoked or otherwise.
  const tokenOrg = orgOfColumn(row.orgId);
  const requestOrg = orgOfColumn(getTenantContext()?.orgId ?? null);
  if (requestOrg === null) {
    logger.warn('invite token refused: the request acts in no org', {
      agentId,
      tokenId: row.id,
      refused: 'no-request-org',
    });
    return { ok: false, reason: 'wrong-org' };
  }
  if (tokenOrg === null || tokenOrg !== requestOrg) return { ok: false, reason: 'wrong-org' };

  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (row.expiresAt && row.expiresAt < new Date()) return { ok: false, reason: 'expired' };
  if (row.maxUses !== null && row.useCount >= row.maxUses) {
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true, token: row };
}

/**
 * Spend one use of a resolved token. Atomic: the increment succeeds only
 * while `use_count < max_uses` (or `max_uses` is NULL, unlimited), so two
 * concurrent callers who both passed `resolveInviteToken` cannot together
 * push a token past its cap — the TOCTOU the read-then-write would have.
 * Returns `false` when the cap was reached in between; the caller refuses.
 */
export async function consumeInviteToken(tokenId: string): Promise<boolean> {
  const updated: number = await prisma.$executeRaw`
    UPDATE ai_agent_invite_token
    SET use_count = use_count + 1
    WHERE id = ${tokenId}
      AND (max_uses IS NULL OR use_count < max_uses)
  `;
  return updated > 0;
}
