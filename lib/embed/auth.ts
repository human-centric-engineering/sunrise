/**
 * Embed Token Authentication
 *
 * Resolves an `X-Embed-Token` header to an agent context for the
 * embeddable chat widget. Creates deterministic anonymous user IDs
 * from the token + client IP so conversations are scoped per-visitor.
 */

import { createHash } from 'crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { resolveCredentialOrg } from '@/lib/tenancy/entry';
import { runAsCredentialLookup } from '@/lib/tenancy/context';

/**
 * Prefix of the synthetic per-visitor id minted below. An embed visitor has no
 * `User` row — the id is a hash of the token and client IP, used to scope
 * a visitor's conversations to them.
 */
export const EMBED_USER_ID_PREFIX = 'embed_';

/**
 * True when an id is a synthetic embed visitor rather than a real `User.id`.
 *
 * Anything writing a caller's id into a **foreign key to `user`** ought to
 * check this first. `AiCostLog.userId` is the case that found it: passing an
 * embed visitor there raises P2003, and because `logCost` swallows write
 * failures by design, the whole cost row is discarded — spend that happened,
 * recorded nowhere. Same failure as #599/#600/#654, one column over.
 *
 * A visitor is recorded apart from `User` (#705, t-765; owner ruling,
 * 2026-10-06), so each writer decides what a visitor gets, and says so where
 * it writes:
 *   - **a conversation** is owned through `AiConversation.embedVisitorId`,
 *     with no `userId` (`conversationOwner` in the streaming chat handler);
 *   - **cost and embedding attribution** record no user;
 *   - **user memory**, **adding provider models** and **sending outbound
 *     messages** are refused (code `anonymous_visitor`);
 *   - **a sub-workflow** runs unowned, as a scheduled run does (`run-workflow`);
 *   - **hook events** carry `userId: null` and the visitor as `embedVisitorId`;
 *   - the document-cleanup tools refuse an embed conversation before they
 *     write anything.
 * A new feature that remembers or runs something for a person must make the
 * same call. Do not read this predicate's existence as a claim that every
 * `user` FK in the tree is covered.
 *
 * Mirrors `isWorkflowAgentId` in the capability dispatcher, which exists for
 * the identical reason on `agentId`.
 */
export function isEmbedUserId(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && userId.startsWith(EMBED_USER_ID_PREFIX);
}

/**
 * The caller's id for a column or payload field that means a `User`: the id
 * itself for a user, `null` for an embed visitor (who is not one) or for no
 * caller at all. The one spelling of that rule, for a writer that records a
 * visitor as no one rather than refusing them.
 */
export function userIdForUserRef(userId: string | null | undefined): string | null {
  return userId && !isEmbedUserId(userId) ? userId : null;
}

export interface EmbedContext {
  agentId: string;
  agentSlug: string;
  userId: string;
  allowedOrigins: string[];
  /**
   * The org the token acts for (§106, t-673) — the one it was minted in,
   * already passed through the read rule, so never null: the route runs its
   * handler inside `runAsOrg(orgId, …, { source: 'embed-token' })`.
   */
  orgId: string;
}

/**
 * Validate an embed token and return the associated agent context.
 * Returns `null` if the token is invalid, inactive, or the agent is disabled
 * — or if the token cannot enter an org: its org is suspended, or it carries
 * none at `multi` (`resolveCredentialOrg`). The org's status rides on the
 * token's own read, so a suspended customer's widget stops with no extra
 * query on the path. The `OPTIONS` preflights read only `allowedOrigins`
 * and refuse the same tokens for the same reason, through this one answer.
 */
export async function resolveEmbedToken(
  token: string,
  clientIp: string
): Promise<EmbedContext | null> {
  try {
    // The token row is tenant-owned and is what tells us the org: the one
    // lookup runs under the credential-lookup scope (§107 t-709).
    const record = await runAsCredentialLookup('embed-token', () =>
      prisma.aiAgentEmbedToken.findUnique({
        where: { token },
        include: {
          agent: {
            select: { id: true, slug: true, isActive: true },
          },
          org: { select: { status: true } },
        },
      })
    );

    if (!record || !record.isActive || !record.agent.isActive) {
      return null;
    }

    const entry = resolveCredentialOrg(
      { orgId: record.orgId, orgStatus: record.org?.status ?? null },
      'embed-token'
    );
    if ('refused' in entry) {
      logger.warn('resolveEmbedToken: token cannot enter its org', {
        tokenId: record.id,
        refused: entry.refused,
      });
      return null;
    }

    // Deterministic anonymous user ID per embed token + IP
    const hash = createHash('sha256')
      .update(`embed:${record.id}:${clientIp}`)
      .digest('hex')
      .slice(0, 16);
    const userId = `${EMBED_USER_ID_PREFIX}${hash}`;

    return {
      agentId: record.agent.id,
      agentSlug: record.agent.slug,
      userId,
      allowedOrigins: record.allowedOrigins,
      orgId: entry.orgId,
    };
  } catch (err) {
    logger.error('resolveEmbedToken failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check if the request origin is allowed by the embed token's allowedOrigins.
 * Empty allowedOrigins = allow all origins.
 */
export function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}
