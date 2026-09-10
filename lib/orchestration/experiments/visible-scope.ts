/**
 * Which experiments a caller may see — the one definition the whole family uses.
 *
 * Three cases, not two. A row is **mine**, **someone else's**, or **nobody's**,
 * and the third is not a rounding error: `AiExperiment.createdBy` is
 * `onDelete: SetNull`, so erasing an admin under Art. 17 leaves every experiment
 * they created with a null owner. Scoping purely to the caller answers "not
 * yours" for those, which makes a deliberately retained row unreachable by
 * everyone — invisible in the list, 404 on every verb, pruned by nothing
 * (t-678).
 *
 * So the visible set is **mine, plus nobody's when the policy permits it**.
 * Never another subject's row: that is the divergence #741 closed, and widening
 * it back is not what this is for.
 *
 * Living in one module is the point. #741 existed because eight handlers over
 * one model disagreed about the answer; a second rule spelled out eight times
 * would decay the same way, and a list that admits orphans while its detail
 * route refuses them is the exact list/detail divergence `checkAuthorizationParity`
 * exists to catch.
 *
 * @see `@/lib/auth/orphan-reads` — who may read an unowned row, and why the
 *      policy rather than this module decides it
 */

import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { mayReadUnattributed, type UnattributedReadKind } from '@/lib/auth/orphan-reads';

/**
 * The resource kind the policy sees for this model.
 *
 * Annotated rather than left inferred, so a value that stops matching
 * `UNATTRIBUTED_READ_KINDS` fails to compile instead of quietly asking the
 * policy a question the guard precomputed a different answer for.
 */
export const EXPERIMENT_RESOURCE_KIND: UnattributedReadKind = 'experiment';

/**
 * The resource kind for `AiDataset`.
 *
 * **A second declaration of the same string**, and it should not have outlived
 * the module it was waiting for: `lib/orchestration/access/dataset-access.ts`
 * now exports its own `DATASET_RESOURCE_KIND`. This one stays only because the
 * `run` route imports it from here, and deleting it means editing that route —
 * t-687's work, not this file's. Both are annotated {@link UnattributedReadKind},
 * so they cannot drift to different values without failing the build; that is
 * containment, not a fix.
 */
export const DATASET_RESOURCE_KIND: UnattributedReadKind = 'dataset';

/**
 * A `where` fragment selecting the experiments `session` may read.
 *
 * `AND` it into a query rather than spreading it — an optional filter built from
 * a query parameter must not be able to overwrite the boundary, and on the
 * widened branch the fragment's key is `OR`, which is exactly the key a careless
 * spread of user-supplied filters would replace.
 *
 * One policy call per request. Ask once and reuse the answer within a handler,
 * so a route's own reads cannot disagree with each other.
 */
export async function visibleExperimentClause(
  session: AuthenticatedSession
): Promise<Prisma.AiExperimentWhereInput> {
  const mine = { createdBy: session.user.id };

  return (await mayReadUnattributed(session.principal, EXPERIMENT_RESOURCE_KIND))
    ? { OR: [mine, { createdBy: null }] }
    : mine;
}

/**
 * Is this row one nobody owns?
 *
 * The claim route needs to tell "unowned, so adoptable" from "owned by someone
 * else, so not yours to take", and both reach it through
 * {@link visibleExperimentClause}. Reading `createdBy === null` at the call site
 * would work but says nothing about why the distinction matters.
 */
export function isUnowned(row: { createdBy: string | null }): boolean {
  return row.createdBy === null;
}
