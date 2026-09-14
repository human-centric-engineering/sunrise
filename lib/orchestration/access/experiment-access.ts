/**
 * Experiment access authorization
 *
 * Single source of truth for "which experiments may this admin see?", and the
 * fourth and last model to arrive in this directory. It was
 * `lib/orchestration/experiments/visible-scope.ts` until t-687 — same rule,
 * different shape, in a directory nothing else about access lived in, which is
 * how it came to answer the ownerless question through a second mechanism
 * without anyone noticing the first.
 *
 * An admin may see an experiment iff
 *
 *   1. They created it (`AiExperiment.createdBy === adminUserId`), OR
 *   2. **Nobody** owns it (`createdBy IS NULL`) and the authorization policy
 *      permits them an unattributed read.
 *
 * Never another admin's experiment. "Belongs to nobody" is a third case, not a
 * softer way of saying "belongs to someone else", and widening the owner clause
 * instead of adding the third case is the divergence #741 closed on this very
 * model — eight handlers each answering the question for themselves.
 *
 * **Why a null owner happens here.** `AiExperiment.createdBy` is
 * `onDelete: SetNull`, so erasing an admin under Art. 17 keeps the experiment
 * and drops the link. Left owner-only, those rows are invisible to everyone,
 * deletable by nobody and pruned by nothing — a row that outlives every
 * operator's ability to reach it (t-678). `claim` is how one becomes normal
 * again.
 *
 * ---
 *
 * **`'orphan'`, not `'system'` — and the schema is why.** `conversation-access`
 * and `execution-access` solve the same shape for rows that arrive ownerless,
 * and they name it `'system'`. The two names are not interchangeable and must
 * not be collapsed: `AiConversation.userId` and `AiWorkflowExecution.userId` are
 * `onDelete: **Cascade**`, so erasing a user deletes those rows and a null there
 * can only ever mean *born* ownerless. `AiExperiment.createdBy` and
 * `AiDataset.userId` are `onDelete: **SetNull**`, so a null there can only ever
 * mean *erased*. One name for both would assert something the database forbids,
 * and would put a stranger's live correspondence and a de-attributed test
 * fixture under the same audit weight. Anyone arriving with "why are there two
 * names for null?" should be pointed at those two `onDelete` clauses.
 *
 * So all four models now share one **mechanism** — a helper in this directory,
 * reading `session.unattributedReads`, returning a named basis and a `where`
 * fragment — and deliberately keep two **vocabularies** for the basis itself.
 *
 * @see `lib/orchestration/access/dataset-access.ts` — the closest analogue; the
 *      other `SetNull` model, and the one an experiment reads through
 * @see `.context/auth/authorization.md` — the roster: which model, which helper,
 *      which basis
 * @see `.context/privacy/data-erasure.md` — why these rows exist at all
 */

import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

/** Why an admin may see an experiment. */
export type ExperimentAccessBasis = 'owner' | 'orphan';

/** The subset of an experiment row this module needs. */
export interface ExperimentOwner {
  createdBy: string | null;
}

/**
 * Prisma `where` fragment selecting the experiments this admin may see.
 *
 * Synchronous: the guard resolved `session.unattributedReads` before the handler
 * ran, so there is no policy call to wait for here. That is what the eager
 * precompute bought, and it is why this reads the record rather than declaring
 * an `EXPERIMENT_RESOURCE_KIND` and passing it to `mayReadUnattributed` — the
 * record's keys *are* `UNATTRIBUTED_READ_KINDS`, so `.experiment` cannot drift
 * out of that list without failing to compile, and there is no `string` on this
 * path to spell wrong. The constant that used to live here was the second
 * declaration of its value; a helper that reads the record needs none.
 *
 * Compose with `AND` when adding filters, so a caller-supplied filter cannot
 * flatten the visibility clause — on the widened branch the fragment's key is
 * `OR`, which is exactly the key a spread of query-parameter filters would
 * replace:
 *
 * ```ts
 * const where = { AND: [experimentVisibilityWhere(session), filters] };
 * ```
 */
export function experimentVisibilityWhere(
  session: AuthenticatedSession
): Prisma.AiExperimentWhereInput {
  const mine = { createdBy: session.user.id };

  return session.unattributedReads.experiment ? { OR: [mine, { createdBy: null }] } : mine;
}

/**
 * Why the admin may see this experiment, or `null` when they may not.
 *
 * Classifies a row that has **already been admitted** by
 * {@link experimentVisibilityWhere} — it does not re-ask the policy, because an
 * ownerless row can only have reached the caller if the policy permitted it.
 * Pass a row fetched some other way and `'orphan'` means only "no owner", not
 * "this caller may read it".
 *
 * **`execution-access.ts` re-asks and this does not**, which is a real
 * difference rather than an inconsistency: the execution detail routes fetch by
 * id and *then* ask, so a null owner there is a fact about the column. Every
 * route in this family fetches under the fragment above first, so a null owner
 * here is already proof the policy said yes.
 *
 * The claim route uses this to tell "unowned, so adoptable" from "mine, so
 * nothing to adopt" — a third party's row was a 404 before it got there.
 *
 * **There is deliberately no `adminCanViewExperiment` yes/no wrapper.**
 * `dataset-access.ts` exports one and nothing calls it; written here it would
 * read as an authorization answer while giving a weaker one, because it returns
 * `true` for every ownerless row whatever the policy said. A caller holding a
 * row fetched some other way needs {@link experimentVisibilityWhere} in the
 * query, not a predicate afterwards.
 */
export function experimentAccessBasis(
  experiment: ExperimentOwner | null | undefined,
  adminUserId: string
): ExperimentAccessBasis | null {
  if (!experiment) return null;
  if (experiment.createdBy === null) return 'orphan';
  if (experiment.createdBy === adminUserId) return 'owner';
  return null;
}

/**
 * Whether routine self-access is recorded, chosen at each call site.
 *
 * There is no default, and that is the point: this task exists because
 * experiments logged nothing about *whose* row an admin had touched, and a
 * helper that quietly picked one rule would let the next handler inherit a
 * decision nobody made. A new experiment route cannot be written without
 * answering this.
 *
 * - `'non-owner-only'` — reads. An admin opening their own experiment is
 *   routine and one row per page view buries the reads that matter. Matches
 *   `logDatasetAccess` and `logConversationAccess`, which apply the rule inside
 *   the helper rather than at the call site.
 * - `'always'` — writes. Every mutation of an `AiExperiment` already wrote an
 *   audit row before this module existed, for every caller including the owner,
 *   and that is the admin audit log doing its other job: recording config
 *   changes. Narrowing it to non-owners to match datasets exactly would delete
 *   rows an operator can read today, which is a loss dressed as consistency.
 *   Datasets are the ones out of step here, not experiments (t-687 states this
 *   rather than fixing it: changing the dataset rule is a decision about what
 *   the audit log is for, not a vocabulary sweep).
 */
export type ExperimentAuditRule = 'always' | 'non-owner-only';

/**
 * Record an admin touching an experiment.
 *
 * Action names are present-tense verbs — `experiment.view`, `experiment.update`
 * — matching `dataset.*` and every other admin action in the tree. Where a name
 * ends in `.create` / `.update` / `.delete` the tense is load-bearing:
 * `actionBadgeVariant` in the audit-log view keys off those suffixes, so a
 * past-tense `experiment.updated` would render as an unremarkable neutral badge
 * instead of a coloured one.
 *
 * **Several legitimate mutations render neutral anyway, and that is the badge's
 * limit rather than a naming mistake.** `experiment.run`, `experiment.claim` and
 * `experiment.verdict_compute` all change a row and all end in `outline`,
 * because the view distinguishes only the three CRUD suffixes. Renaming one of
 * them to earn a colour would say something false about what it does — a verdict
 * compute is not an `.update` in the sense the badge means. Widening what the
 * view colours is the fix if that ever matters; it is not this module's call.
 *
 * **The list is deliberately not logged, on either rule.** A page of the
 * caller's own experiments that happens to include a few orphans is not an
 * access worth a row each, and logging impressions would bury the detail reads
 * and writes that are. Same call as datasets make, stated here so the next
 * reader knows it was a decision.
 */
export function logExperimentAccess(params: {
  adminUserId: string;
  experimentId: string;
  experimentName: string | null;
  basis: ExperimentAccessBasis;
  /** Route-level action name, e.g. `'experiment.view'`. */
  action: string;
  /** Whether the caller's own rows are recorded too. No default — see the type. */
  record: ExperimentAuditRule;
  extra?: Record<string, unknown>;
  clientIp?: string | null;
}): void {
  if (params.record === 'non-owner-only' && params.basis === 'owner') return;
  logAdminAction({
    userId: params.adminUserId,
    action: params.action,
    entityType: 'experiment',
    entityId: params.experimentId,
    entityName: params.experimentName,
    // `extra` first: the basis is the one field an audit reader trusts, and a
    // caller passing an `accessBasis` key must not be able to relabel their own
    // access. Same rule as the `where` clauses — the security key goes last, so
    // nothing can spread over it.
    metadata: { ...params.extra, accessBasis: params.basis },
    clientIp: params.clientIp ?? null,
  });
}
