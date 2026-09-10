/**
 * Rows that belong to nobody, and who may read them.
 *
 * An owner-scoped route asks "is this row mine?". That question has three
 * answers, not two: mine, someone else's, and **nobody's**. The third arises
 * on every model `CLAUDE.md` tells us to make `onDelete: SetNull` — retained
 * config and audit rows, whose owner column is nulled when the person is erased
 * under Art. 17 — and on every model whose rows are *born* ownerless, like a
 * scheduled workflow run or an inbound conversation. A `where` clause keyed on
 * the caller silently answers "not yours" for all of them, which turns a
 * retained row into an unreachable one: invisible to every admin, deletable by
 * none, and pruned by nothing.
 *
 * That is what this module exists to prevent. It is deliberately **not** a
 * relaxation of the owner clause — re-admitting every admin to every other
 * admin's rows is the divergence #741 closed. Nobody's row is a different
 * question from someone else's, and it gets its own answer.
 *
 * **The answer comes from the policy, not from here.** `canRead`'s `ReadTarget`
 * union has an `'unattributed'` arm for precisely this shape, and
 * `DEFAULT_AUTHORIZATION_POLICY` answers it with `administersEverything` — so
 * platform staff reach ownerless rows and a fork narrows that by registering a
 * policy rather than by editing a route. A fork whose org admins must not see
 * another department's abandoned work overrides `canRead` and these routes
 * follow, with no diff here.
 *
 * ## Ask once per request, not once per reader
 *
 * The guards resolve the whole answer — every kind in
 * {@link UNATTRIBUTED_READ_KINDS} — before the handler runs, and hand it over as
 * `session.unattributedReads`. **A handler reads that value; it does not call
 * this module.** Two things follow, and both are the point:
 *
 * - **The readers are synchronous.** A visibility fragment built inline inside a
 *   larger object has nowhere clean to `await`, and a family of helpers that are
 *   async only because of this question infects every call site with one.
 * - **One request cannot disagree with itself.** A list and the rows it links to
 *   ask the policy once, together, rather than once each.
 *
 * The cost is a fixed number of policy calls on every guarded request, including
 * requests that touch none of these models. On a default install that is free —
 * the built-in rule does no I/O. **A fork whose policy hits a database pays it
 * per request, and should cache inside its own policy**; that cost was weighed
 * against asking on demand and accepted, because the alternative restructures
 * every call site that builds a query filter inline. See
 * `.context/auth/authorization.md`.
 *
 * {@link mayReadUnattributed} remains for the caller the precompute cannot serve
 * — chiefly a fork with an ownerless model of its own, whose kind is not in the
 * core list.
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
 * @see `.context/auth/authorization.md` — the seam, and the `'unattributed'` arm
 * @see `.context/privacy/data-erasure.md` — why these rows exist at all
 */

import { canRead, readUnattributedKind } from '@/lib/auth/authorization';
import type { AuthorizationPrincipal } from '@/lib/auth/authorization';

/**
 * The core models that can hold a row nobody owns — the kinds the guards
 * precompute an answer for.
 *
 * This is the canonical spelling of each kind, and a second spelling elsewhere
 * would split the policy's answer in two without anything going red: a fork
 * answering for `'execution'` would silently not answer for `'workflow-execution'`.
 * The value is what a fork's `canRead` sees as `resource.kind`, and what the
 * default policy's per-kind log line names, so it is the model's own noun and
 * matches the `entityType` the admin audit log already uses for it.
 *
 * Ordered as declared; nothing depends on the order.
 */
export const UNATTRIBUTED_READ_KINDS = [
  /** `AiConversation.userId` — null by birth on an inbound (SMS / email / Slack) thread. */
  'conversation',
  /** `AiDataset.userId` — `SetNull`, so null means an erasure detached it. */
  'dataset',
  /** `AiWorkflowExecution.userId` — null by birth on a scheduled or triggered run. */
  'execution',
  /** `AiExperiment.createdBy` — `SetNull`, so null means an erasure detached it. */
  'experiment',
] as const;

/** One of the core ownerless-capable models. See {@link UNATTRIBUTED_READ_KINDS}. */
export type UnattributedReadKind = (typeof UNATTRIBUTED_READ_KINDS)[number];

/**
 * Which kinds of ownerless row this caller may read — decided once, by the
 * guard, before the handler runs.
 *
 * **A total record, not a set of the permitted kinds.** Every kind is present
 * with an explicit `true` or `false`, so "denied" cannot be spelled the same way
 * as "nobody asked about this one" — which is the collapse `ReadTarget` exists
 * to prevent, and it would be no better here.
 */
export type UnattributedReads = Readonly<Record<UnattributedReadKind, boolean>>;

/**
 * May this caller read rows of `kind` that have no owner?
 *
 * **Prefer `session.unattributedReads`** for the core kinds: it is the same
 * answer, already resolved, and synchronous. This is the on-demand form, and it
 * is what a fork with an ownerless model of its own calls — `kind` is open for
 * exactly that reason, while {@link UnattributedReads} is closed over the core
 * list the guards can enumerate.
 *
 * Ask once per request and reuse the answer: a list and the rows it links to
 * must not disagree, and this is one policy call, not one per row.
 *
 * A policy that throws is handled by `canRead` itself: it falls back to safe
 * mode, whose `'unattributed'` arm is `false`. The failure direction is
 * therefore "orphans stay hidden", never "orphans become public".
 */
export function mayReadUnattributed(
  principal: AuthorizationPrincipal,
  kind: string
): Promise<boolean> {
  return canRead(principal, readUnattributedKind(kind));
}

/**
 * Ask the policy about every core kind at once. Called by the guards.
 *
 * Sequential rather than `Promise.all`, because a fork's policy is likely to be
 * doing one lookup it can cache across the four calls, and firing them together
 * would defeat that on the first request of every process. There is no I/O to
 * overlap on a default install.
 *
 * Written as a seeded literal filled by a loop, rather than either half alone.
 * The literal is what makes the record total at the type level — add a kind to
 * {@link UNATTRIBUTED_READ_KINDS} and this stops compiling until it is answered
 * here — and it seeds `false` so an interrupted fill hides ownerless rows rather
 * than exposing them. The loop is what stops the kinds being spelled a second
 * time: `mayReadUnattributed` takes an open `string`, so a typo in a hand-written
 * call would compile and silently ask about a kind no policy answers for.
 */
export async function resolveUnattributedReads(
  principal: AuthorizationPrincipal
): Promise<UnattributedReads> {
  const reads: Record<UnattributedReadKind, boolean> = {
    conversation: false,
    dataset: false,
    execution: false,
    experiment: false,
  };
  for (const kind of UNATTRIBUTED_READ_KINDS) {
    reads[kind] = await mayReadUnattributed(principal, kind);
  }
  return reads;
}
