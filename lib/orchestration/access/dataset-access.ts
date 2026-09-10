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
 * **This sits beside two older siblings and deliberately differs from them in
 * two ways.** `conversation-access.ts` and `execution-access.ts` solve the same
 * shape for rows that arrive ownerless — an inbound SMS thread, a scheduled
 * run — and they are worth reading before changing anything here.
 *
 * - **The basis is `'orphan'`, not `'system'`.** Same column state, different
 *   story. A `'system'` conversation was *never* personal: it belongs to the
 *   deployment and always did. An `'orphan'` dataset *was* somebody's, and the
 *   link was removed by an erasure. Calling that `'system'` would assert
 *   something false, and the two deserve different audit weight — a stranger's
 *   correspondence is not a de-attributed test fixture. Datasets are never born
 *   ownerless: all three create paths stamp `userId`.
 *
 * - **The widening is policy-gated; theirs is unconditional.** Those helpers
 *   hard-code "every admin sees every ownerless row". This asks
 *   {@link mayReadUnattributed}, so a fork narrows it by registering a policy
 *   and editing no route — which the multi-tenancy programme needs and they
 *   predate. Converging the three onto one mechanism is its own task; doing it
 *   here would mean editing shipped conversation and execution routes.
 *
 * @see `lib/orchestration/access/execution-access.ts` — the closest analogue
 * @see `.context/privacy/data-erasure.md` — why these rows exist at all
 */

import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { mayReadUnattributed, type UnattributedReadKind } from '@/lib/auth/orphan-reads';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

/**
 * The resource kind the authorization policy sees for this model.
 *
 * Annotated rather than left inferred: the guards precompute an answer per kind,
 * so a value this constant no longer shares with `UNATTRIBUTED_READ_KINDS` would
 * have this helper asking the policy about one string while the session carried
 * an answer for another — two answers inside one request, silently. The
 * annotation makes that a compile error. t-687 collapses the two declarations.
 */
export const DATASET_RESOURCE_KIND: UnattributedReadKind = 'dataset';

/** Why an admin may see a dataset. */
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
 * const where = { AND: [await datasetVisibilityWhere(session), ...filters] };
 * ```
 *
 * One policy call per request. Ask once and reuse the answer inside a handler
 * so its own reads cannot disagree with each other.
 */
export async function datasetVisibilityWhere(
  session: AuthenticatedSession
): Promise<Prisma.AiDatasetWhereInput> {
  const mine = { userId: session.user.id };

  return (await mayReadUnattributed(session.principal, DATASET_RESOURCE_KIND))
    ? { OR: [mine, { userId: null }] }
    : mine;
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
