/**
 * Rows that belong to nobody, and who may read them.
 *
 * An owner-scoped route asks "is this row mine?". That question has three
 * answers, not two: mine, someone else's, and **nobody's**. The third arises
 * on every model `CLAUDE.md` tells us to make `onDelete: SetNull` — retained
 * config and audit rows, whose owner column is nulled when the person is erased
 * under Art. 17. A `where` clause keyed on the caller silently answers "not
 * yours" for all of them, which turns a retained row into an unreachable one:
 * invisible to every admin, deletable by none, and pruned by nothing.
 *
 * That is what this module exists to prevent. It is deliberately **not** a
 * relaxation of the owner clause — re-admitting every admin to every other
 * admin's rows is the divergence #741 closed. Nobody's row is a different
 * question from someone else's, and it gets its own answer.
 *
 * **The answer comes from the policy, not from here.** `canRead`'s `ReadTarget`
 * union already has an `'unattributed'` arm for precisely this shape, and
 * `DEFAULT_AUTHORIZATION_POLICY` answers it with `administersEverything` — so
 * platform staff reach ownerless rows and a fork narrows that by registering a
 * policy rather than by editing a route. A fork whose org admins must not see
 * another department's abandoned work overrides `canRead` and these routes
 * follow, with no diff here.
 *
 * **A fork overriding this arm is deciding more than reading.** `canRead` is a
 * read predicate, but a route that builds its visible set from the answer uses
 * that set for its writes too — edit, delete, and anything the row can be made
 * to do. So `case 'unattributed': return isOrgAdmin(viewer)`, written to mean
 * "org admins may VIEW de-attributed rows for audit", also hands them deletion
 * and any cost-incurring action over those rows, with no second predicate to
 * consult and no diff in the routes to review. Decide the wider question before
 * widening this arm. If the seam ever grows a write-side question for unowned
 * rows, this is where it belongs.
 *
 * **Asking this trips a diagnostic that is aimed at something else.** The
 * default policy's `'unattributed'` arm logs, once per kind per process,
 * `"a route named a resource with no ownerId — denying non-admins"`, and tells
 * you to give a resolver an `ownerId`. There is no resolver here and nothing to
 * correct: the arm cannot currently tell "a resolver named a row it could not
 * attribute" from "does this principal may-read unowned rows of kind X at all".
 * So an install with no ownerless rows still sees one line naming `experiment`
 * and one naming `dataset`, and both are false alarms — see #754.
 *
 * Narrowing the warning to resources carrying an `id` was tried and reverted:
 * it would silence a fork whose resolver really is misconfigured and returns no
 * id, which is the case the diagnostic exists for. Trading a real warning for a
 * cosmetic one is the wrong way round. The fix is a separate question on the
 * seam, not a narrower predicate here.
 *
 * @see `.context/auth/authorization.md` — the seam, and the `'unattributed'` arm
 * @see `.context/privacy/data-erasure.md` — why these rows exist at all
 */

import { canRead } from '@/lib/auth/authorization';
import type { AuthorizationPrincipal } from '@/lib/auth/authorization';

/**
 * May this caller read rows of `kind` that have no owner?
 *
 * Ask once per request and reuse the answer — a list and the rows it links to
 * must not disagree, and this is one policy call, not one per row.
 *
 * `kind` is the resource kind the policy sees (`'experiment'`, `'dataset'`). It
 * is what lets a fork answer differently per model, and what the default
 * policy's once-per-kind log line names, so pass the model's own noun rather
 * than a generic label.
 *
 * A policy that throws is handled by `canRead` itself: it falls back to safe
 * mode, whose `'unattributed'` arm is `false`. The failure direction is
 * therefore "orphans stay hidden", never "orphans become public".
 */
export function mayReadUnattributed(
  principal: AuthorizationPrincipal,
  kind: string
): Promise<boolean> {
  return canRead(principal, { kind: 'unattributed', resource: { kind } });
}
