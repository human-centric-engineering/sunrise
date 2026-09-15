/**
 * Evaluation-dataset access authorization
 *
 * Single source of truth for "which datasets may this admin see?". Every
 * `AiDataset` read gates through this rather than hand-rolling its own
 * `userId` comparison — the divergence that produced #741 on the sibling
 * model was nine handlers each answering that question for themselves.
 *
 * An admin may see a dataset iff
 *
 *   1. They own it (`AiDataset.userId === adminUserId`), OR
 *   2. **Nobody** owns it (`userId IS NULL`) and the authorization policy
 *      permits them an unattributed read.
 *
 * Never another admin's dataset. "Belongs to nobody" is a third case, not a
 * softer way of saying "belongs to someone else", and widening the owner
 * clause instead of adding the third case is what #741 closed.
 *
 * **Why a null owner happens here.** `AiDataset.userId` is `onDelete: SetNull`,
 * so erasing an admin under Art. 17 keeps the dataset and drops the link. Left
 * owner-only, those rows are invisible to everyone, deletable by nobody, and
 * pruned by nothing — a row that outlives every operator's ability to reach it
 * (t-679).
 *
 * ---
 *
 * **This sits beside three siblings and deliberately differs from two of them
 * in one way.** `conversation-access.ts` and `execution-access.ts` solve the
 * same shape for rows that arrive ownerless — an inbound SMS thread, a
 * scheduled run — and they are worth reading before changing anything here.
 *
 * **The basis is `'orphan'`, not `'system'`.** Same column state, different
 * story, and disjoint by database constraint. A `'system'` conversation was
 * *never* personal: `AiConversation.userId` is `onDelete: Cascade`, so erasing
 * the user would have deleted the row, and a null there can only mean the row
 * was born ownerless. `AiDataset.userId` is `onDelete: SetNull`, so a null here
 * can only mean an erasure detached it — the dataset *was* somebody's. Calling
 * that `'system'` would assert something the schema forbids, and the two deserve
 * different audit weight: a stranger's correspondence is not a de-attributed
 * test fixture. Datasets are never born ownerless — all three create paths stamp
 * `userId`.
 *
 * `experiment-access.ts` is the other `SetNull` model and the closest analogue
 * of the three; it names its third case `'orphan'` for exactly this reason.
 *
 * Since t-687 all four read the same precomputed answer and are synchronous.
 * This helper used to `await` `mayReadUnattributed`, asking the policy a
 * second time for an answer the guard already had.
 *
 * @see `lib/orchestration/access/experiment-access.ts` — the closest analogue
 * @see `.context/auth/authorization.md` — the roster: which model, which helper,
 *      which basis
 * @see `.context/privacy/data-erasure.md` — why these rows exist at all
 */

import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

/**
 * Why an admin may see a dataset.
 *
 * **Two-valued, and the ownership axis is becoming three-valued.** This union
 * encodes the assumption that the visible set is exactly *{mine} ∪ {nobody's}*
 * — true of every route today, and what makes {@link datasetAccessBasis}'s
 * `null` mean "not admitted by the clause" rather than a third case.
 * `.context/auth/authorization.md` already carries the target that breaks it:
 * `scope.ownership` is `'own' | 'team' | 'all'`, and `'team'` is a row the
 * caller may legitimately read and does not own — a case this type cannot
 * name. **Whoever widens {@link datasetVisibilityWhere} past those two sets
 * must widen this union in the same change**, or every audit row written over
 * a newly-admitted row is wrong, and wrong in the direction that matters: the
 * audit log is where an operator would look to find out reads had widened.
 * The handlers narrow a null to a 404 (t-693) precisely so that a widened
 * clause fails loudly on its first test run instead of filing a colleague's
 * dataset as an abandoned one. Same note on `ExperimentAccessBasis`.
 */
export type DatasetAccessBasis = 'owner' | 'orphan';

/** The subset of a dataset row this module needs. */
export interface DatasetOwner {
  userId: string | null;
}

/**
 * Why the admin may see this dataset, or `null` when they may not.
 *
 * Classifies a row that has **already been admitted** by
 * {@link datasetVisibilityWhere} — it does not re-ask the policy, because an
 * ownerless row can only have reached the caller if the policy permitted it.
 * Pass a row fetched some other way and `'orphan'` means only "no owner", not
 * "this caller may read it".
 *
 * Callers that need to tell the two apart — to log an action taken on a row
 * that is not the caller's own — use this; callers wanting a yes/no use
 * {@link adminCanViewDataset}.
 */
export function datasetAccessBasis(
  dataset: DatasetOwner | null | undefined,
  adminUserId: string
): DatasetAccessBasis | null {
  if (!dataset) return null;
  if (dataset.userId === null) return 'orphan';
  if (dataset.userId === adminUserId) return 'owner';
  return null;
}

/** Whether the admin may see an already-fetched dataset row. */
export function adminCanViewDataset(
  dataset: DatasetOwner | null | undefined,
  adminUserId: string
): boolean {
  return datasetAccessBasis(dataset, adminUserId) !== null;
}

/**
 * Prisma `where` fragment selecting the datasets this admin may see.
 *
 * Compose with `AND` when adding filters, so a caller-supplied filter cannot
 * flatten the visibility clause — on the widened branch the fragment's key is
 * `OR`, which is exactly the key a spread of query-parameter filters would
 * replace:
 *
 * ```ts
 * const where = { AND: [datasetVisibilityWhere(session), filters] };
 * ```
 *
 * Synchronous: the guard resolved `session.unattributedReads` before the handler
 * ran, so there is no policy call to wait for here. Reading the record is also
 * what retires this module's `DATASET_RESOURCE_KIND` — the record's keys *are*
 * `UNATTRIBUTED_READ_KINDS`, so `.dataset` cannot drift out of that list without
 * failing to compile, and there is no `string` on this path to spell wrong. One
 * answer per request, so a handler's own reads cannot disagree with each other.
 */
export function datasetVisibilityWhere(session: AuthenticatedSession): Prisma.AiDatasetWhereInput {
  const mine = { userId: session.user.id };

  return session.unattributedReads.dataset ? { OR: [mine, { userId: null }] } : mine;
}

/**
 * Record an admin touching a dataset that is not their own.
 *
 * `'owner'` is routine self-access and is not logged, matching
 * `logConversationAccess`. Action names are present-tense verbs — `dataset.view`,
 * `dataset.update` — matching `experiment.*` and every other admin action in the
 * tree, because `actionBadgeVariant` in the audit-log view keys off the `.update`
 * / `.delete` suffix and a past-tense name renders as an unremarkable neutral
 * badge. `'orphan'` is logged: the row was somebody's, an
 * erasure detached it, and who reached it afterwards is worth knowing.
 *
 * **`basis` is never defaulted by a caller.** Every site narrows the helper's
 * `null` to a 404 immediately after its guarded fetch, as `loadDataset` in the
 * detail route always has: a null means the row was not admitted by the
 * visibility clause — the state a widening regression produces — and a
 * `?? 'orphan'` there would file it as an ordinary orphan read in the log an
 * operator would use to notice that regression (t-693).
 *
 * **Deliberately weaker than the conversation rule, and here is the line.**
 * A `'system'` conversation holds a living third party's correspondence, so
 * every read of one is logged. An orphan dataset holds test fixtures whose
 * personal link the erasure already removed, so this logs **the detail read
 * and every write**, and not a list page that merely happens to include
 * orphans among the caller's own rows. Logging list impressions would bury the
 * rows that matter under one entry per page view.
 */
export function logDatasetAccess(params: {
  adminUserId: string;
  datasetId: string;
  datasetName: string | null;
  basis: DatasetAccessBasis;
  /** Route-level action name, e.g. `'dataset.viewed'`. */
  action: string;
  extra?: Record<string, unknown>;
  clientIp?: string | null;
}): void {
  if (params.basis === 'owner') return;
  logAdminAction({
    userId: params.adminUserId,
    action: params.action,
    entityType: 'dataset',
    entityId: params.datasetId,
    entityName: params.datasetName,
    // `extra` first: the basis is the one field an audit reader trusts, and a
    // caller passing an `accessBasis` key must not be able to relabel their own
    // access. Same rule as the `where` clauses — the security key goes last, so
    // nothing can spread over it.
    metadata: { ...params.extra, accessBasis: params.basis },
    clientIp: params.clientIp ?? null,
  });
}
