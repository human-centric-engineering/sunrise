/**
 * Workflow-execution access authorization
 *
 * Single source of truth for "can this admin see this execution?". Every
 * execution route — list, detail, status, live, lease, report, review,
 * approve/reject/cancel, force-fail, retry-step, rerun, counts, and the
 * live-engine snapshot — gates through this module rather than comparing
 * `execution.userId` to the session id inline.
 *
 * Two bases:
 *
 *   1. `'owner'`  — the caller started the run (`userId === session.user.id`).
 *   2. `'system'` — nobody started it: schedule- and inbound-triggered runs
 *                   carry `userId = null` because the work is the
 *                   organisation's, not a person's (#502). An admin reaches
 *                   them when the authorization policy permits them an
 *                   unattributed read.
 *
 * **Why `'system'` exists.** Before #502 these rows were stamped with the
 * operator who configured the schedule or trigger, which made a third party's
 * inbound SMS look like that operator's personal data — erasing them
 * cascade-deleted the correspondence, and a subject-access export disclosed
 * it. Nulling the column fixes both, but a null owner matches no admin, so
 * without this basis every scheduled and inbound run would vanish from the
 * admin UI: invisible in the list, un-cancellable, and — for a run paused at
 * an approval gate — permanently stuck, since no one could approve it.
 *
 * The widening is bounded and it is no longer decided here. It is NOT a
 * general cross-user grant — one admin still cannot see another admin's own
 * runs, whatever the policy says, because that is a different question from
 * "may I see the rows nobody owns".
 *
 * ## The policy decides, and it has already been asked
 *
 * Until t-685 this module hard-coded the answer: every admin saw every
 * system-owned run. That is right on a single-tenant install and wrong under a
 * customer tier, where one tenant's admin would see every other tenant's
 * scheduled runs — and a fork registering a narrower `canRead` could not change
 * it, because nothing here asked.
 *
 * Now the answer arrives on the session. The guards resolve
 * `session.unattributedReads` for every core ownerless-capable model before the
 * handler runs (`lib/auth/orphan-reads.ts`), so **these helpers stay
 * synchronous**: they read a resolved boolean rather than awaiting a policy
 * call. That is what lets the live-engine snapshot go on composing `where`
 * fragments inline inside a larger object, and it is why this is a signature
 * change rather than a restructuring.
 *
 * `session.unattributedReads.execution` is the kind's name taken from
 * `UNATTRIBUTED_READ_KINDS` rather than re-spelled: the record's keys *are* that
 * list, so a rename there fails to compile here. The sibling modules declare an
 * annotated `*_RESOURCE_KIND` constant because they pass a `string` to
 * `mayReadUnattributed`; there is no string to get wrong on this path, so there
 * is no constant to keep in step.
 *
 * ## One grant this module does not decide
 *
 * `approve`, `reject` and `cancel` admit a caller this module refuses, when the
 * run's own trace names them in `approverUserIds`. That is deliberate and was
 * left alone: it is a per-run nomination the workflow made, not an answer to the
 * ownerless question, and narrowing it here would strand a scheduled run at its
 * gate forever — nobody owns it, so with the delegation gone there is nobody
 * left to approve it, which is the #502 failure the `'system'` basis exists to
 * prevent. `conversation-access.ts` draws the same line around its `'shared'`
 * basis. A fork narrowing `canRead` inherits that exception, so it is pinned in
 * `tests/unit/app/api/v1/admin/orchestration/executions/policy-narrowing.test.ts`
 * rather than left to be rediscovered.
 *
 * @see lib/auth/orphan-reads.ts — the kinds, who answers, and what it costs
 * @see lib/orchestration/access/conversation-access.ts — same model for
 *      conversations, where the third basis is `'shared'`
 * @see .context/privacy/data-erasure.md — why these rows are system-owned
 */

import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';

/** Why an admin may see an execution. */
export type ExecutionAccessBasis = 'owner' | 'system';

/** The subset of an execution row this module needs. */
export interface ExecutionOwner {
  userId: string | null;
}

/**
 * Why the admin may see this execution, or `null` when they may not.
 *
 * **This re-asks the ownerless question, unlike `datasetAccessBasis`.** That
 * sibling classifies a row already admitted by its own `where` fragment, so it
 * can take "no owner" as proof the policy allowed it. The execution detail
 * routes do the opposite — they fetch by id and then ask — so a null owner
 * here is only a fact about the column, and the permission still has to be
 * checked. Reading `session.unattributedReads.execution` is what makes a
 * narrowing fork's 404 arrive on `/executions/[id]` and not just on the list.
 *
 * Callers that need to distinguish the two bases (e.g. to log an action
 * taken on a system-owned run) use this; callers that only need a yes/no
 * use {@link adminCanViewExecution}.
 */
export function executionAccessBasis(
  execution: ExecutionOwner | null | undefined,
  session: AuthenticatedSession
): ExecutionAccessBasis | null {
  if (!execution) return null;
  if (execution.userId === null) {
    return session.unattributedReads.execution ? 'system' : null;
  }
  if (execution.userId === session.user.id) return 'owner';
  return null;
}

/**
 * Whether the admin may see (and act on) an already-fetched execution row.
 *
 * Routes translate `false` to a 404 rather than a 403 — surfacing "this
 * execution exists but isn't yours" is an id-enumeration vector.
 */
export function adminCanViewExecution(
  execution: ExecutionOwner | null | undefined,
  session: AuthenticatedSession
): boolean {
  return executionAccessBasis(execution, session) !== null;
}

/**
 * Prisma `where` fragment selecting the executions this admin may see: their
 * own, plus every system-owned run when the policy permits an unattributed
 * read.
 *
 * Compose with `AND` when adding filters, so a caller-supplied filter can't
 * flatten the visibility clause — on the widened branch the fragment's key is
 * `OR`, which is exactly the key a spread of query-parameter filters would
 * replace:
 *
 * ```ts
 * const where = { AND: [executionVisibilityWhere(session), ...filters] };
 * ```
 */
export function executionVisibilityWhere(
  session: AuthenticatedSession
): Prisma.AiWorkflowExecutionWhereInput {
  const mine = { userId: session.user.id };

  return session.unattributedReads.execution ? { OR: [mine, { userId: null }] } : mine;
}
