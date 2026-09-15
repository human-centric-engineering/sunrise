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
 * **Both properties now hold for all four kinds**, which is what makes this
 * module the single primitive: it is called once per request, by the guard, and
 * by nothing else in core. Every reader is a helper in
 * `lib/orchestration/access/` — one module per model — and every one of them is
 * synchronous because it reads the record rather than asking again. Executions
 * arrived in t-685, conversations in t-686, datasets and experiments in t-687.
 * Until then the cost below was paid in full while two of the four still asked
 * on demand, which was the deliberate shape of an integration checkpoint rather
 * than an oversight.
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
 * ## This arm decides more than reading, in both directions
 *
 * `canRead` is a read predicate, but every core surface over an ownerless row
 * builds on its answer — the list that finds the row, the detail route that
 * opens it, and the writes: `PATCH` / `DELETE /conversations/:id`, the
 * `allUsers` scope of `POST /conversations/clear`, and `approve` / `reject` /
 * `cancel` / `force-fail` / `retry-step` / `rerun` on an execution. There is no
 * second predicate for writes, deliberately (below), so the arm's answer is the
 * whole answer.
 *
 * **Widening it grants more than a view.** `case 'unattributed': return
 * isOrgAdmin(viewer)`, written to mean "org admins may VIEW de-attributed rows
 * for audit", also hands them deletion and every cost-incurring action over
 * those rows, with no diff in the routes to review.
 *
 * **Narrowing it closes routes that have no other door.** A principal the
 * policy refuses cannot find an ownerless row, so it cannot act on one either —
 * and two of those actions matter more than visibility. An inbound thread holds
 * the messages of someone with **no account here**: `eraseUser()` cannot reach
 * them, and `DELETE /conversations/:id` is the only Art. 17 route they have. A
 * scheduled run paused at a `human_approval` gate names its approvers in its
 * trace, and the act routes honour that nomination whatever the policy says —
 * but the approvals queue is `GET /executions?status=paused_for_approval`, so a
 * named approver the policy refuses can clear a gate they have no surface to
 * find (t-690). That is the position `.context/admin/orchestration-approvals.md`
 * already documents for every delegated approver on every install — the
 * notification link is their route — extended to rows nobody owns.
 *
 * **So a policy must admit at least one principal to each kind, and
 * {@link checkOwnerlessReachability} is how a fork proves its policy does.** It
 * is the check to run beside `checkAuthorizationParity`, over the same roster of
 * principals: for every kind here it reports the kinds nobody you named may
 * read, and says what that closes. The platform operator role that should hold
 * this reach under a customer tier is identity's to define (§106), which is also
 * why the org's own scheduled runs and inbound threads stop being *ownerless*
 * for that org's admins only once `canRead` sees `scope.org` — see
 * {@link resolveUnattributedReads}. Decided on t-690 / t-691, recorded on
 * `f-mt-authz`.
 *
 * **Why there is no `canWrite` face.** A write question for ownerless rows was
 * weighed and deferred: no fork asks to separate "may read" from "may delete"
 * over these rows, the principal it would name is §106's, and a face designed
 * before that principal exists would be designed against the wrong identity
 * model. The trigger to revisit is a fork that needs read-yes / write-no over
 * ownerless rows — an auditor tier — or §106 landing, whichever is first. If it
 * is ever added, this module is where it belongs.
 *
 * @see `.context/auth/authorization.md` — the seam, and the `'unattributed'` arm
 * @see `.context/privacy/data-erasure.md` — why these rows exist at all
 */

import { canRead, readUnattributedKind } from '@/lib/auth/authorization';
import type {
  AuthorizationPolicy,
  AuthorizationPrincipal,
  AuthorizationScope,
} from '@/lib/auth/authorization';

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
 * **No core helper spells a kind any more, and that is what holds it.** There
 * used to be three `*_RESOURCE_KIND` constants annotated
 * {@link UnattributedReadKind}, which catches a rename *out of* the union and
 * nothing else — `'dataset'` and `'experiment'` are both members, so one
 * declaration could drift to the other's value and still build, and
 * `orphan-reads.test.ts` had to pin each to its literal as well. t-687 deleted
 * them: every reader of {@link UnattributedReads} accesses the record by
 * property, the record's keys *are* this list, and
 * `session.unattributedReads.experiment` cannot drift out of it without failing
 * to compile. There is no `string` left on that path to get wrong.
 *
 * {@link mayReadUnattributed} still takes an open `string`, because a fork's own
 * ownerless model is not in the record. A fork adding one gets the constant
 * problem back, and the annotation is the tool for it.
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

/** One principal to test a policy's ownerless arm against. */
export interface OwnerlessReachabilityCase {
  /** Names the case in a violation. Defaults to the principal's user id. */
  label?: string;
  viewer: AuthorizationPrincipal;
  scope?: AuthorizationScope;
}

/** A kind of ownerless row that none of the named principals may read. */
export interface OwnerlessReachabilityViolation {
  /** The kind nobody reaches, or `'(none)'` for a setup fault. */
  kind: string;
  /** The labels of every case that was asked. */
  asked: readonly string[];
  /** What is wrong, in a sentence an assertion message can print verbatim. */
  message: string;
}

/**
 * What closes when nobody may read rows of a kind — the consequence each
 * violation names, so a fork reading the failure knows what it is choosing.
 *
 * A total record over {@link UNATTRIBUTED_READ_KINDS}: adding a kind there does
 * not compile until its consequence is written here, for the same reason
 * {@link resolveUnattributedReads} is a seeded literal — the thing that would
 * otherwise be forgotten is the thing the type demands.
 */
const OWNERLESS_KIND_CONSEQUENCE: Readonly<Record<UnattributedReadKind, string>> = {
  conversation:
    'an inbound (SMS / email / Slack) thread is invisible to every admin you named, and `DELETE /conversations/:id` — the only Art. 17 erasure route a sender with no account has — is closed to all of them.',
  dataset:
    'an evaluation dataset an erasure de-attributed is readable and deletable by nobody you named, and pruned by nothing.',
  execution:
    'a scheduled or inbound-triggered run is invisible to every admin you named; one paused at a `human_approval` gate can be found by none of them and waits for the 7-day abandoned-approval reap.',
  experiment:
    'an experiment an erasure de-attributed is readable and claimable by nobody you named, and pruned by nothing.',
};

function isCoreKind(kind: string): kind is UnattributedReadKind {
  return UNATTRIBUTED_READ_KINDS.some((known) => known === kind);
}

function consequenceOf(kind: string): string {
  return isCoreKind(kind)
    ? OWNERLESS_KIND_CONSEQUENCE[kind]
    : `rows of kind "${kind}" that nobody owns are reachable by none of the principals you named.`;
}

/**
 * Check that every kind of ownerless row is readable by **someone** the fork
 * names, and report each kind that is not.
 *
 * The companion to `checkAuthorizationParity`, run over the same roster of
 * principals. Parity proves a policy's two read faces agree; this proves the
 * policy has not closed a door that has no other key. A narrowing `canRead` is
 * the seam working as designed — but a principal the policy refuses cannot find
 * an ownerless row, so it cannot delete an inbound thread on a data subject's
 * behalf or clear the approval gate a scheduled run is paused at, and if the
 * policy refuses *every* principal those routes are closed to the whole
 * install. Nothing at request time can tell a fork that; this can, in its test
 * suite, before the policy ships.
 *
 * **Name the operator principal, not only the narrowed ones.** The case a fork
 * writes first is the org admin its policy is *for*, and that case is supposed
 * to be refused. The check passes when at least one case reaches each kind, so
 * the roster must include whichever principal the fork intends to hold that
 * reach — which is also the principal parity should be run over.
 *
 * A pure function returning violations rather than an assertion helper, with no
 * test-framework import, for the same reason as its companion: a fork's own
 * harness calls it, and Sunrise's thin assertion lives in `tests/`. It calls the
 * policy you pass, not the registered one, so it is safe to run over a candidate
 * before registering it. A policy that throws is not caught here — in a test
 * that is the failure you want to see.
 *
 * **It reports a setup fault as a violation**, as its companion does: run over
 * zero principals it could not have found anything, and a check that passes
 * while proving nothing is the failure this module is written against.
 *
 * `kinds` defaults to the core roster. A fork with an ownerless model of its own
 * adds that model's kind; a fork that has decided, deliberately, that a kind is
 * unreachable on its install passes the kinds it does want checked — the
 * decision is then visible at the call site rather than silent.
 *
 * ```ts
 * const unreachable = await checkOwnerlessReachability(myPolicy, [
 *   { label: 'an org admin', viewer: { userId: 'u1', role: 'USER', credential: 'session' } },
 *   { label: 'platform staff', viewer: { userId: 'u2', role: 'ADMIN', credential: 'session' } },
 * ]);
 * expect(unreachable).toEqual([]);
 * ```
 */
export async function checkOwnerlessReachability(
  policy: AuthorizationPolicy,
  cases: readonly OwnerlessReachabilityCase[],
  kinds: readonly string[] = UNATTRIBUTED_READ_KINDS
): Promise<OwnerlessReachabilityViolation[]> {
  if (cases.length === 0) {
    return [
      {
        kind: '(none)',
        asked: [],
        message:
          'checkOwnerlessReachability was called with no principals, so it could not have found a kind nobody reaches. Pass every principal your policy is meant to admit — including the operator one.',
      },
    ];
  }

  const asked = cases.map((c) => c.label ?? c.viewer.userId);
  const violations: OwnerlessReachabilityViolation[] = [];

  for (const kind of kinds) {
    const target = readUnattributedKind(kind);
    let reached = false;
    for (const testCase of cases) {
      // `=== true`, as the runtime `canRead` wrapper requires: a policy that
      // returns a truthy non-boolean is DENIED on a request, and a check that
      // counted it as reached would pass while the door stayed shut.
      if ((await policy.canRead(testCase.viewer, target, testCase.scope ?? {})) === true) {
        reached = true;
        break;
      }
    }
    if (reached) continue;

    violations.push({
      kind,
      asked,
      message: `No principal you named may read ownerless "${kind}" rows (asked: ${asked.join(', ')}) — ${consequenceOf(kind)} Add the principal that should hold that reach, or drop the kind from the call to say you have accepted this.`,
    });
  }

  return violations;
}
