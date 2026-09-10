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
 * **Neither property holds yet, and this is the file where that has to be said.**
 * Nothing in core reads `session.unattributedReads`: `visibleExperimentClause`,
 * `datasetVisibilityWhere` and the experiments `run` route all still `await`
 * {@link mayReadUnattributed}, so a datasets request asks the policy about
 * `'dataset'` twice — once in the precompute, once on demand. The cost below is
 * paid now and the benefit arrives with t-685 / t-686 / t-687, which is the
 * deliberate shape of an integration checkpoint rather than an oversight.
 *
 * The cost is a fixed number of policy calls on every guarded request, including
 * requests that touch none of these models. On a default install that is free —
 * the built-in rule does no I/O. **A fork whose policy hits a database pays it
 * per request and will want to cache — but cache PER REQUEST, not per process.**
 * The policy object is registered once for the life of the process, so the
 * obvious `Map` keyed on `userId` hanging off it serves a demoted admin their
 * old answer until the next deploy. Scope the cache to the request
 * (`AsyncLocalStorage`, or a value threaded from wherever the fork already
 * resolves the org) so a permission change takes effect on the next request.
 *
 * **It is also paid by a request that is about to be shed.** The guard runs
 * before the handler body, and 38 guarded routes open with an in-handler
 * per-flow cap (`return createRateLimitResponse(...)`), so a caller being rate
 * limited still costs a fork four policy lookups. The eager argument does not
 * cover that case — nothing in the guard can see a cap that lives inside the
 * handler — and moving the work later would mean the route opt-in this scheme
 * deliberately does not have.
 *
 * That cost was weighed against asking on demand and accepted, because the
 * alternative restructures every call site that builds a query filter inline.
 * See `.context/auth/authorization.md`.
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
 * The kinds the guards precompute an answer for.
 *
 * **Not "the models that can hold an ownerless row" — that is a much longer
 * list.** The schema has 19 nullable `User` relations declared `onDelete:
 * SetNull`, every one of which can hold a row an Art. 17 erasure detached:
 * `AiWorkflow`, `AiAgent`, `AiKnowledgeDocument`, `McpApiKey` and a dozen more.
 * What these four have that the others do not is a **read path that asks the
 * policy about it**. The rest are admin-global — every admin reads every row —
 * so there is no owner clause for an orphan to fall outside of, and nothing to
 * precompute.
 *
 * **That makes this list a consequence, not a roster, and it is the thing to
 * extend when the consequence changes.** Owner-scoping one of those models means
 * adding its kind here in the same change; leave it out and its orphans become
 * invisible to everyone, deletable by nobody and pruned by nothing — the t-678
 * defect, arriving silently. It cannot be derived from the schema the way
 * `SUBJECT_DATA_SOURCES` is, because the property that decides membership lives
 * in the route, not the column: a schema-derived check would demand a key for
 * every admin-global model and precompute 19 answers nobody asked for.
 *
 * The value is what a fork's `canRead` sees as `resource.kind`, and what the
 * default policy's per-kind log line names, so it is the model's own noun and
 * matches the `entityType` the admin audit log already uses for it. **A second
 * spelling of the same model splits the policy's answer in two with nothing
 * going red** — a helper asking about `'eval-dataset'` while the guard resolved
 * `'dataset'` gets two answers inside one request, which is the disagreement the
 * precompute exists to remove.
 *
 * **Two mechanisms hold that, and neither is complete on its own.** The three
 * `*_RESOURCE_KIND` constants that exist (`DATASET_RESOURCE_KIND` twice,
 * `EXPERIMENT_RESOURCE_KIND` once) are annotated {@link UnattributedReadKind}, so
 * a rename *out of* the union fails to compile — but `'dataset'` and
 * `'experiment'` are both in the union, so an annotation alone would let one
 * declaration drift to the other's value and still build. `orphan-reads.test.ts`
 * pins each constant to its literal for that reason. **`conversation` and
 * `execution` have no constant anywhere** — `conversation-access.ts` and
 * `execution-access.ts` hard-code the widening and never name a kind — so
 * t-685 and t-686 must take their value from this list rather than invent one.
 * t-687 collapses the lot into one declaration per model, which is the real fix;
 * this is containment until then.
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
 * Sequential rather than `Promise.all`, and the trade is real in both
 * directions: sequential lets a fork's per-request cache serve calls two to four
 * from the first one's lookup, while `Promise.all` would fire all four before
 * any of them populated it — but an **uncached** fork policy pays four
 * serialized round trips where it could have paid one. Sequential is the
 * conservative half of that: its worst case is bounded latency, whereas running
 * a fork's policy four times concurrently assumes a concurrency-safety property
 * nothing here can check. There is no I/O to overlap on a default install.
 *
 * Asked with an empty {@link AuthorizationScope}, which is what every core
 * caller passes today — so the precomputed answer is identical to the on-demand
 * one it replaces. **§106 is the trigger to revisit it**: once a fork's `canRead`
 * reads `scope.org`, an answer computed with no org in context is the wrong one
 * to cache on the session, and this is the line that has to change.
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
