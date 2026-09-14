/**
 * Conversation access authorization
 *
 * Single source of truth for "can this admin view this conversation?".
 * Every conversation route — list, detail, messages, provenance, export —
 * gates through this helper rather than hand-rolling its own check.
 *
 * The rule: an admin can view a conversation iff
 *
 *   1. They own it (`AiConversation.userId === session.user.id`), OR
 *   2. The owner has created an active share record, OR
 *   3. Nobody owns it (`userId IS NULL`) — an inbound thread (SMS,
 *      WhatsApp, email, Slack) belongs to the deployment, not to a person —
 *      **and the authorization policy permits this caller an unattributed
 *      read**.
 *
 * "Active" means: `revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now())`.
 *
 * **Only the third arm asks the policy.** Arms 1 and 2 are untouched by it:
 * owning a row and being given an active share are facts about this caller and
 * this row, not questions about a class of rows. A fork narrowing `canRead`
 * therefore loses inbound threads and keeps everything else — and no policy
 * value can widen arms 1 or 2, which is what stops "nobody owns this" being
 * quietly rewritten into "somebody else owns this".
 *
 * **Two faces, and they must agree.** {@link adminCanViewConversation} answers
 * yes/no about one row; {@link conversationVisibilityWhere} is the `where`
 * fragment selecting the set. A list that admits an inbound thread while its
 * detail route refuses it is the divergence this module exists to prevent — and
 * nothing mechanical catches it, so they are written next to each other and
 * share the policy answer they read.
 *
 * Before t-686 the second face did not exist: `conversations/route.ts` and
 * `conversations/search/route.ts` each spelled the three arms out again, the
 * search route in raw SQL. Those are the copies that disagree.
 *
 * **Why the `'system'` basis exists.** Inbound conversations used to be
 * stamped with the operator who configured the trigger, which made a third
 * party's messages look like that operator's personal data: erasing them
 * cascade-deleted the correspondence, and a subject-access export disclosed
 * it. #502 nulled the column. A null owner matches no admin, so without this
 * basis every inbound thread would drop out of the admin UI entirely — no
 * list entry, no transcript, and no way to delete one when the person who
 * sent the messages asks you to.
 *
 * The person on the other end of an inbound thread is a data subject with no
 * account here, so nothing about `'system'` access is routine: it is logged
 * exactly like `'shared'`.
 *
 * The helper is a pure read — no audit log writes happen here. Callers
 * decide whether to log:
 *
 *   - `basis === 'owner'`: routine self-access, skip logging.
 *   - `basis === 'shared'` / `'system'`: access to data that is not the
 *     caller's own, ALWAYS log via `logConversationAccess` (see
 *     `lib/orchestration/audit/admin-audit-logger.ts`).
 *
 * The `ownerId` field is surfaced so callers can record the conversation's
 * owner on the audit row without an extra DB round-trip.
 *
 * Future extension: when a `COMPLIANCE_OFFICER` role lands, this helper
 * will grow a third basis (`'compliance'`) that bypasses the share check
 * for documented-legal-basis access. The audit-of-audits requirements for
 * that path are stricter (mandatory justification text, user
 * notification); the helper signature can absorb that without callers
 * needing to change.
 */

import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';

export type AccessBasis = 'owner' | 'shared' | 'system';

export interface AdminCanViewResult {
  /** True when the admin can access the conversation. */
  ok: boolean;
  /** Why access was granted, or `null` when denied / not found. */
  basis: AccessBasis | null;
  /**
   * The conversation's owner userId. Surfaced so audit-log callers can
   * record cross-user accesses (`basis === 'shared'`) without an extra
   * DB round-trip. `null` when the conversation does not exist.
   */
  ownerId: string | null;
}

const DENY: AdminCanViewResult = { ok: false, basis: null, ownerId: null };

/**
 * Returns whether the calling admin can access a conversation, and why.
 *
 * One DB query (`findUnique` with share include). No audit log writes —
 * the caller is responsible for logging cross-user accesses.
 *
 * Returns `{ ok: false, basis: null, ownerId: null }` when the
 * conversation doesn't exist. Routes typically translate this to a 404.
 */
export async function adminCanViewConversation(
  conversationId: string,
  session: AuthenticatedSession
): Promise<AdminCanViewResult> {
  const conversation = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    select: {
      userId: true,
      share: {
        select: {
          revokedAt: true,
          expiresAt: true,
        },
      },
    },
  });

  if (!conversation) return DENY;

  // System-owned (inbound) — checked before the owner comparison so a null
  // caller id could never be read as owning an unowned row.
  //
  // The policy's answer, resolved by the guard before this handler ran. A fork
  // that refuses unattributed reads gets `DENY` here, which routes translate to
  // a 404 exactly as they do for a stranger's conversation — the caller cannot
  // tell "no such thread" from "not yours", which is the same non-enumeration
  // posture the deny below has always had.
  if (conversation.userId === null) {
    return session.unattributedReads.conversation
      ? { ok: true, basis: 'system', ownerId: null }
      : DENY;
  }

  if (conversation.userId === session.user.id) {
    return { ok: true, basis: 'owner', ownerId: conversation.userId };
  }

  const share = conversation.share;
  if (share && isShareActive(share)) {
    return { ok: true, basis: 'shared', ownerId: conversation.userId };
  }

  // Conversation exists but caller is neither owner nor shared-with.
  // Return the ownerId as null so callers translate to a generic 404
  // — leaking the owner's identity on a denied access would be a
  // user-enumeration vector.
  return DENY;
}

/**
 * Prisma `where` fragment selecting the conversations this admin may see — the
 * set form of {@link adminCanViewConversation}, and the same three arms.
 *
 * Compose with `AND` when adding filters, never by spreading it alongside them.
 * The fragment's key is `OR`, which is exactly the key a spread of
 * query-parameter filters would replace:
 *
 * ```ts
 * const where = { AND: [conversationVisibilityWhere(session), ...filters] };
 * ```
 *
 * **The share arm repeats `isShareActive`'s predicate inline, and has to.**
 * Prisma's query builder takes data, not a function, so the rule exists twice
 * by construction: once as TypeScript for a row already fetched, once as a
 * `where` clause for rows not fetched yet. They are pinned against each other
 * in `conversation-access.test.ts`; if you change one, the test tells you about
 * the other.
 *
 * `excludeShared` is for a caller counting *its own* conversations, where a
 * thread merely shared with the admin is still someone else's and would
 * overstate the total — the observability dashboard's active-conversation count
 * is the one such caller. It only ever narrows, so it is safe by omission in a
 * way the policy arm is not.
 */
export function conversationVisibilityWhere(
  session: AuthenticatedSession,
  options: { excludeShared?: boolean } = {}
): Prisma.AiConversationWhereInput {
  const arms: Prisma.AiConversationWhereInput[] = [{ userId: session.user.id }];

  // Arm 3, and the only one the policy decides. Omitted entirely rather than
  // emitted as a falsifiable clause: an arm that matched nothing would still be
  // an arm, and `OR` with a dead arm invites the next reader to "simplify" it
  // back into something that matches.
  if (session.unattributedReads.conversation) {
    arms.push({ userId: null });
  }

  if (!options.excludeShared) {
    arms.push({
      share: {
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
  }

  // Never `{}` — `arms` always carries the owner clause, so a narrowed caller
  // cannot fall through to every row. A single-arm `OR` is left as an `OR`
  // rather than flattened, so every caller composes against the same shape.
  return { OR: arms };
}

/**
 * Active share predicate.
 *
 * A share is active when it has not been revoked AND has either no
 * expiry or an expiry in the future. Exported for use by routes that
 * need to surface "is this conversation currently shared?" in their
 * UI (e.g. the admin list view's `shared` badge).
 */
export function isShareActive(share: { revokedAt: Date | null; expiresAt: Date | null }): boolean {
  if (share.revokedAt !== null) return false;
  if (share.expiresAt !== null && share.expiresAt <= new Date()) return false;
  return true;
}
