/**
 * Conversation access authorization
 *
 * Single source of truth for "can this admin view this conversation?".
 *
 * Every per-id conversation route gates through {@link adminCanViewConversation},
 * and the list through {@link conversationVisibilityWhere}. **Three surfaces do
 * neither, each on purpose, and one of them reads the same policy answer by a
 * shorter road.**
 *
 * Semantic search hand-writes the predicate in SQL, because a pgvector distance
 * query is not expressible through Prisma's query builder; the copies are pinned
 * against each other in the tests. `conversations/export` is hard-scoped to the
 * caller's own rows — bulk export of other people's conversations is a privacy
 * footgun, so it sees neither shared nor ownerless threads and has no reason to
 * consult this module.
 *
 * The third is `conversations/clear`, whose `allUsers` scope is a bulk
 * `deleteMany` over every user's rows — wider than any per-id rule, by design.
 * It reads `session.unattributedReads.conversation` directly for the one arm
 * this module decides: ownerless threads are in a narrowed caller's set exactly
 * when they are in their list (t-691). Until then it consulted nothing, so a
 * fork narrowing `canRead` refused an admin one inbound thread on `DELETE
 * /conversations/:id` and let them destroy every inbound thread here. **Before
 * adding a surface, check it against all three rather than assuming this module
 * is the only door.**
 *
 * The analytics service is a fourth kind of reader, and it has its own face:
 * {@link deploymentWideConversationWhere}. Analytics aggregate over every
 * user's threads by design — "what are people asking my agents?" is the
 * product, and an admin's own conversations would answer a different question
 * — so the per-caller set is the wrong clause for it. What the policy decides
 * is still only the ownerless arm, and that face applies that arm alone (t-694).
 * `conversations/clear` reads the same answer inline for its `allUsers` scope.
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
 * search route in raw SQL. The list now calls the fragment; search still holds
 * its copy, of necessity, and the tests compare the two.
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
 * **That last route is the one a narrowing policy must not close to everyone.**
 * `PATCH` and `DELETE /conversations/:id` accept the `'owner'` and `'system'`
 * bases, so the policy's answer decides the writes as well as the reads — and
 * the sender of an inbound thread has no account, so `eraseUser()` cannot
 * reach their messages and deleting the thread is their only Art. 17 remedy.
 * There is deliberately no separate write predicate (`lib/auth/orphan-reads.ts`
 * says why, and what would change that). A fork narrowing this arm keeps some
 * principal its policy admits to ownerless conversations, and proves it with
 * `checkOwnerlessReachability`, which names this consequence when none is.
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

/**
 * The answer, as a discriminated union on `ok`.
 *
 * **A permitted result always carries a basis, and the type says so.** This
 * used to be one shape with `basis: AccessBasis | null` for both outcomes, so
 * a caller that had already thrown on `!ok` still held a nullable basis and
 * wrote `access.basis ?? 'owner'` to satisfy the audit logger — which skips
 * `'owner'`. Every one of those four sites was therefore ready to write **no
 * audit row at all** on the one model that holds a living third party's
 * correspondence, should a null ever arrive. It cannot arrive: this helper
 * fetches and classifies the row itself, and every `ok: true` branch below
 * names its basis. So the two-state type was the defect, not the callers, and
 * narrowing on `ok` is now what removes the `??` (t-693).
 *
 * Read together with the "ownership axis is becoming three-valued" note on
 * `dataset-access.ts`: {@link AccessBasis} names three reasons, and the
 * moment a policy admits a fourth kind of row — an org peer's thread under
 * §106's `'team'` — this union must grow it in the same change, or the audit
 * row over a newly-admitted row is wrong. Here that is a compile error at the
 * `switch`-shaped sites, which is the loud failure the type is for.
 */
export type AdminCanViewResult =
  | {
      /** The admin can access the conversation. */
      ok: true;
      /** Why. Never `null` on a permitted result. */
      basis: AccessBasis;
      /**
       * The conversation's owner userId. Surfaced so audit-log callers can
       * record cross-user accesses (`basis === 'shared'`) without an extra
       * DB round-trip. `null` on a system-owned thread.
       */
      ownerId: string | null;
    }
  | {
      /** Denied, or no such conversation — the two are deliberately one answer. */
      ok: false;
      basis: null;
      ownerId: null;
    };

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
      // `userId: { not: null }` is what keeps this arm in step with
      // {@link adminCanViewConversation}, which decides an ownerless row on the
      // policy alone and never reaches its share check. Without it the two faces
      // disagree about one row — ownerless AND carrying an active share — which
      // the list would show and the detail route would 404. Unreachable today
      // (only an owner can create a share, and `AiConversation.user` is
      // `onDelete: Cascade`, so a share cannot outlive its owner), and pinned
      // anyway: the guarantee this module states is what the next reader builds
      // on, and "currently unreachable" is not the same as "cannot happen".
      //
      // It is also the right answer on its own terms. A share is the owner's
      // consent; a row nobody owns has nobody who could have given it.
      userId: { not: null },
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
 * Prisma `where` fragment for a surface that reads **every user's** conversations
 * by design and asks the policy only about the ones nobody owns.
 *
 * {@link conversationVisibilityWhere} is the set one admin may open; this is
 * the set a deployment-wide reader may aggregate. They differ on arm 1 — a
 * member's chat with a public agent is not the admin's own, is not shared with
 * them, and is not ownerless, so it is outside the per-caller set and inside
 * this one. The analytics service is the reader (t-694): narrowing it to the
 * per-caller set would have emptied the dashboard of every member's
 * conversation on every install, which nobody asked for and which is not what
 * the policy decides.
 *
 * What the policy decides is arm 3, and this is arm 3 alone: `{}` when the
 * policy admits the caller to ownerless threads — the default install, where
 * the clause is byte-for-byte what the reader emitted before it existed — and
 * `{ userId: { not: null } }` when it refuses, which drops an inbound thread's
 * messages out of every aggregate the same way the list, search and detail
 * routes drop the thread. The `allUsers` scope of `conversations/clear` spells
 * this same fragment inline.
 *
 * Its only key is `userId`, so it spreads safely beside date and agent filters;
 * a reader that also filters by owner has no business calling it — that reader
 * wants the per-caller set. When §106 attributes threads to an org, the
 * customer tier's analytics land here as a `'team'` arm, not in the readers.
 */
export function deploymentWideConversationWhere(
  session: AuthenticatedSession
): Prisma.AiConversationWhereInput {
  return session.unattributedReads.conversation ? {} : { userId: { not: null } };
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
