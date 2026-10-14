/**
 * Subject context — whose rows the current call stack may read (§115 t-800).
 *
 * The tenant context (`lib/tenancy/context.ts`) answers "which org?", and the
 * data layer enforces that answer on every query. Inside one org it is silent:
 * whether a caller may read *another member's* conversation is decided by
 * `subjectScope()` in the guard and handed to the route as
 * `session.subjectFilter` — and goes no further. A library function two calls
 * below the route cannot ask, so it cannot be checked, and §115's data-layer
 * assertion (t-801) has nothing to check it against. This module carries the
 * guard's answer down, the same way and for the same reason the org is
 * carried: the handlers are owner-unaware by design, and the subject is a
 * property of the request, decided once at the boundary.
 *
 * **Who enters it.** `withAuth` / `withAdminAuth` enter it around every handler
 * they run — cookie session or API key — with the principal they built. Nothing
 * else does, deliberately:
 *
 *   • background work (the maintenance tick, schedules, the retention pruner)
 *     acts for no person, so it has no subject and is not narrowed;
 *   • the credential routes that never consulted the policy — MCP, embed,
 *     webhook and inbound triggers, approval tokens — enter none either. Their
 *     credential is not a person the policy narrows (an MCP key is an
 *     admin-provisioned integration, an embed visitor is not a member), so
 *     entering a subject there would be inventing a policy answer rather than
 *     carrying one. That is a recorded choice for §115, not an oversight.
 *
 * "No subject" therefore means "not narrowed", which is what keeps this inert
 * for every path that does not pass through a guard — and is why a
 * guard-less route reading personal rows is the thing to look for in review.
 *
 * **Lazy, and memoised per request.** The guard computes `subjectScope()` only
 * for routes whose ownership declaration needs it (`runHandler` in
 * `lib/auth/guards.ts` says why). The data layer needs the answer only when a
 * query touches a personal model, so it asks here and the policy is consulted
 * at most once per request, whichever side asks first. When the guard already
 * computed it, that value is reused, so the route and the data layer can never
 * be handed two different answers for one request.
 *
 * **The scope follows the async subtree**, as the tenant context does: work a
 * handler starts — a streamed response body, a `$transaction`, a fire-and-forget
 * promise — keeps the subject, and work it did not start does not see it.
 *
 * That is right for a streamed body and wrong for work that acts for someone
 * else once it is started. Resuming an approved execution runs the
 * execution's owner's workflow, not the approver's, and through the
 * approval-token route it has no subject at all; inherited from an approving
 * admin it would read that owner's rows narrowed to the admin. So a library
 * function whose work belongs to no person in the request says so itself, with
 * {@link runAcrossOwners} and its reason (`resumeApprovedExecution` does), and
 * every caller — a guarded route, a token route, the scheduler — gets the same
 * answer. Decided on §115 t-801 over detaching the subject at each call site,
 * which every new fire-and-forget would have to remember.
 *
 * Not imported by the authorization module, and importing nothing from it at
 * runtime: the data layer reads this, and `lib/db/client.ts` must not reach the
 * fork's policy file through an import chain.
 *
 * @see .context/auth/authorization.md — "The subject context"
 * @see lib/db/owner-classification.ts — which models the subject narrows
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@/lib/logging';
import type { AuthorizationPrincipal, SubjectFilter } from '@/lib/auth/authorization';
import type { UnattributedReads } from '@/lib/auth/orphan-reads';

/** What a guard hands over when it enters the context. */
export interface SubjectEntry {
  /** The principal the guard built and the policy was asked about. */
  principal: AuthorizationPrincipal;
  /**
   * The policy's answer, when the guard already computed it. Reused, so the
   * route's `session.subjectFilter` and the data layer agree by construction —
   * but copied on entry, so a handler that mutates the object it was handed
   * cannot change the data layer's answer for the rest of the request.
   */
  filter?: SubjectFilter;
  /** Computes the answer when {@link filter} is absent. Called at most once unless it fails. */
  resolveFilter: () => Promise<SubjectFilter>;
  /** The ownerless kinds this caller may read — the guard's resolved record. */
  unattributedReads: UnattributedReads;
  /**
   * Whether a share admits rows for this caller — `true` only from
   * `withAdminAuth`, the surface a share consents to. Absent means `false`, the
   * narrower answer. See `OwnerReader.readsShared` in `lib/db/owner-extension.ts`.
   */
  readsShared?: boolean;
  /**
   * Called when the data layer checked a personal read for this caller and it
   * passed (§115 t-801) — the guard counts it as the route having used the
   * policy's answer. See {@link noteConfinedRead}.
   */
  onConfinedRead?: () => void;
  /**
   * Called when a read reached a personal model the data layer does not check
   * yet — the guard then does not count {@link onConfinedRead} as covering the
   * route. See {@link noteUncheckedRead}.
   */
  onUncheckedRead?: () => void;
}

/**
 * The data layer's question, answered.
 *
 *   • `none`     — no subject was entered (a job, a guard-less route). Not narrowed.
 *   • `admitted` — inside {@link runAcrossOwners}: the code said, with a reason,
 *                  that this read crosses owners on purpose. Not narrowed.
 *   • `subject`  — a guarded request. `filter.userId` present means narrowed to
 *                  that user; absent means this caller may see every subject.
 */
export type SubjectReadScope =
  | { kind: 'none' }
  | { kind: 'admitted'; reason: string; principal: AuthorizationPrincipal }
  | {
      kind: 'subject';
      principal: AuthorizationPrincipal;
      filter: SubjectFilter;
      unattributedReads: UnattributedReads;
      readsShared: boolean;
    };

interface SubjectStore {
  entry: SubjectEntry;
  /**
   * Shared by every reader in the request: the policy is asked once, and each
   * crossing reason is logged once.
   */
  memo: { filter: Promise<SubjectFilter> | null; crossings: Set<string> };
  /** Set by {@link runAcrossOwners}; scoped to its callback. */
  admitted: string | null;
}

const subjectContext = new AsyncLocalStorage<SubjectStore>();

/** As in `lib/tenancy/context.ts`: await inside the scope so a lazy `PrismaPromise` cannot escape it. */
async function settleInside<T>(fn: () => Promise<T>): Promise<T> {
  return await fn();
}

/**
 * Run `fn` as `entry.principal`. The guards call this around every handler;
 * nothing else should — see the module header for who deliberately does not.
 */
export function runAsSubject<T>(entry: SubjectEntry, fn: () => Promise<T>): Promise<T> {
  const memo = {
    filter: entry.filter ? Promise.resolve({ ...entry.filter }) : null,
    crossings: new Set<string>(),
  };
  return subjectContext.run({ entry, memo, admitted: null }, () => settleInside(fn));
}

/**
 * Run `fn` as a deliberate read across owners.
 *
 * For the code that genuinely must see other members' personal rows for a
 * narrowed caller — an org-wide aggregate that returns only numbers, a
 * reconcile acting for the org rather than the person. The `reason` is
 * logged, as `runAsSystem`'s is, because an unexplained crossing is exactly
 * what a review needs to find; the sites are meant to be few and greppable.
 * It is logged when a crossing happens — the first read inside `fn` that the
 * owner layer would have checked, for a caller the policy narrowed — and once
 * per reason per request, so a crossing wrapped around a per-row helper is one
 * line rather than one per row. A caller who is not narrowed (a platform
 * admin) crosses nothing and logs nothing; outside a subject (a job) it
 * changes nothing at all.
 *
 * Not a tenancy bypass. The org wall stays where it is; this only lifts the
 * owner check inside it.
 */
export function runAcrossOwners<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  const current = subjectContext.getStore();
  if (!current) return settleInside(fn);
  return subjectContext.run({ ...current, admitted: reason }, () => settleInside(fn));
}

/**
 * Whose rows the current call stack may read. The data layer's one entry
 * point; route code keeps reading `session.subjectFilter`.
 *
 * Never throws for a policy failure: `subjectScope()` (what the guard hands in
 * as `resolveFilter`) already answers from safe mode — the caller's own rows —
 * when the policy throws or returns something unusable. Should that fallback
 * itself fail, the failure is not memoised: this read rejects, and the next one
 * asks again rather than inheriting the same rejection for the whole request.
 */
export async function getSubjectReadScope(): Promise<SubjectReadScope> {
  const store = subjectContext.getStore();
  if (!store) return { kind: 'none' };
  const { entry, memo, admitted } = store;
  memo.filter ??= entry.resolveFilter().catch((err: unknown) => {
    memo.filter = null;
    throw err;
  });
  // Copied, as the guard copies the policy's answer: the memo is shared by
  // every reader in the request, and a caller that mutated what it was handed
  // would change the next reader's scope.
  const filter = { ...(await memo.filter) };
  if (admitted !== null) {
    // Logged here rather than on entering `runAcrossOwners`: only now is there
    // a read the owner layer would have checked, and only a narrowed caller
    // had a check to cross.
    if (filter.userId !== undefined && !memo.crossings.has(admitted)) {
      memo.crossings.add(admitted);
      logger.info('Reading across owners', {
        reason: admitted,
        userId: entry.principal.userId,
      });
    }
    return { kind: 'admitted', reason: admitted, principal: entry.principal };
  }
  return {
    kind: 'subject',
    principal: entry.principal,
    filter,
    unattributedReads: entry.unattributedReads,
    readsShared: entry.readsShared === true,
  };
}

/**
 * Tell the guard that the data layer checked a personal read for the current
 * subject and it passed. Called by `lib/db/owner-extension.ts`; a no-op outside
 * a subject.
 */
export function noteConfinedRead(): void {
  subjectContext.getStore()?.entry.onConfinedRead?.();
}

/**
 * Tell the guard that a read reached a personal model the owner layer does not
 * check yet. Called by `lib/db/owner-extension.ts`; a no-op outside a subject.
 */
export function noteUncheckedRead(): void {
  subjectContext.getStore()?.entry.onUncheckedRead?.();
}
