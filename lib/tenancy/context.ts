/**
 * Tenant context — which org the current call stack is acting for (§106).
 *
 * The primitive everything downstream reads: the guards ENTER it for every
 * request they admit, the log context reads it, and the data layer
 * (`lib/db/tenancy-extension.ts`, §107) stamps and scopes every query by it. It is an `AsyncLocalStorage`, the
 * `lib/auth/signup-mode.ts` precedent, and not a parameter threaded through
 * handlers, because the handlers are tenancy-unaware by design: the org is a
 * property of the request, decided once at the boundary.
 *
 * **Who enters it, and who does not.** `withAuth` / `withAdminAuth` enter it
 * from the session's `activeOrgId`, the org bound to an API key, or the
 * verified resolver header (`lib/tenancy/entry.ts`); the guard-less routes
 * enter it from their own credential — the webhook trigger from its API key,
 * the embed routes from the embed token, the MCP transport from the MCP key
 * (each credential is bound to an org at mint, t-673); the two routes whose
 * credential is a signed token naming a ROW — the inbound trigger, the HMAC
 * approval token — read that row and enter its org (§107 t-708). Every one
 * of those resolvers reads its credential row before an org is known, and
 * does so under {@link runAsCredentialLookup} (t-709). An agent invite token
 * enters nothing: it is a gate the session passes through, checked against
 * the org the guard entered. Background jobs enter it per job (§108 t-711):
 * every task in the maintenance tick declares a scope and
 * `lib/orchestration/maintenance/job-scope.ts` runs it through
 * {@link forEachOrg} (per org, the default) or {@link runAsSystem} (once,
 * audited, for system tables only). A path nobody taught to enter an org
 * still runs outside any context — which at `single` answers the install
 * org (see {@link requireTenantContext}) and at `multi` refuses, so it
 * fails loud rather than reads wide.
 *
 * **And what outlives the request that created it has to leave it.** The store
 * propagates into `setInterval`, so a process-lifetime timer armed inside a
 * request would keep that request's org for ever — {@link runDetached} is how
 * such a timer is armed (§108 t-715).
 *
 * **At `single` the install org is the only answer.** A single-tenant install
 * runs exactly the same components (design record, request-path diagram);
 * the difference is that "nothing entered a context" resolves to the install
 * org instead of throwing. That is what keeps one code path rather than a
 * dormant multi-tenant branch.
 *
 * Not a fork seam: forks resolve a tenant through `lib/app/tenant-resolver.ts`
 * (the proxy) and read the context through these exports; they do not enter
 * it themselves.
 *
 * Tenancy posture: async-local — the store the rest of the manifest is
 * defined against (lib/tenancy/process-state.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '@/lib/env';
import { registerLogTenancy } from '@/lib/admin/logs';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import type { OrgRole } from '@/lib/tenancy/roles';

/**
 * How the org was decided. The design record's seven, plus `implicit` — the
 * single-tenant fallback {@link requireTenantContext} answers when nothing
 * entered a context, named so a log line can tell it from a real entry —
 * and the two signed-token entries of §107 t-708: `inbound-trigger` (a
 * channel signature over a workflow's trigger row) and `approval-token` (an
 * HMAC token over an execution id), where the org is the ROW's, read under a
 * system scope before it is entered.
 */
export type TenantContextSource =
  | 'session'
  | 'api-key'
  | 'embed-token'
  | 'mcp-key'
  | 'resolver'
  | 'inbound-trigger'
  | 'approval-token'
  | 'system'
  | 'job'
  | 'implicit';

export interface TenantContext {
  /** The org this call stack acts for. `null` only for a `system` scope. */
  orgId: string | null;
  source: TenantContextSource;
  /**
   * The caller's role in `orgId`, when the entering code looked it up —
   * stored here so nothing downstream does a second membership read.
   * Absent for a system scope, a job, or a caller with no membership.
   */
  role?: OrgRole | null;
}

const tenantContext = new AsyncLocalStorage<TenantContext>();

/** True when this install runs more than one org. Read once per call, not cached. */
export function isMultiTenant(): boolean {
  return env.TENANCY_MODE === 'multi';
}

// Teach the admin log buffer whose lines it is holding (§108 t-714).
//
// The registration points THIS way — server-only module into the buffer —
// because `lib/admin/logs.ts` must keep no runtime imports: the logger reaches
// it with a literal `require`, and the logger is imported by client
// components, so an edge from the buffer to this module puts `pg` in the
// browser bundle. `lib/admin/logs.ts` says the same thing at more length.
registerLogTenancy({
  orgId: () => getTenantContext()?.orgId ?? null,
  multi: isMultiTenant,
});

/** The context the current call stack runs in, or `null` when none was entered. */
export function getTenantContext(): TenantContext | null {
  return tenantContext.getStore() ?? null;
}

/**
 * The context the current call stack runs in, with the single-tenant answer
 * when none was entered.
 *
 * At `multi` a missing context is a bug — a request path or job that nobody
 * taught to enter one — and the only safe response is to refuse before a
 * query runs wide. At `single` the install org is the one org there is, so
 * the answer is that, marked `implicit`.
 */
export function requireTenantContext(): TenantContext {
  const current = tenantContext.getStore();
  if (current) return current;
  if (isMultiTenant()) {
    throw new Error(
      'No tenant context: this call stack was not entered for an org. At TENANCY_MODE=multi every ' +
        'request and job must run inside runAsOrg / runAsSystem / forEachOrg (see .context/tenancy/context.md).'
    );
  }
  return { orgId: INSTALL_ORG_ID, source: 'implicit' };
}

/**
 * The org this call stack acts for, for a lookup that has to name it.
 *
 * A per-org unique key is the case: `orgId_slug` on an agent, a knowledge
 * base or a document (§107 t-708) cannot be asked without saying whose
 * `support` is meant. Same answers as {@link requireTenantContext}, and the
 * one scope that has no org — `system` — is refused too: a global scope
 * cannot name one org's row by slug, it has to search
 * (`findFirst({ where: { slug, orgId } })`).
 */
export function requireOrgId(): string {
  const { orgId } = requireTenantContext();
  if (orgId) return orgId;
  throw new Error(
    'No org in the tenant context: this call stack runs as the system scope, which has no org to name. ' +
      'A per-org lookup (orgId_slug) belongs inside runAsOrg.'
  );
}

/**
 * Await the callback's result INSIDE the scope, not just call it there.
 *
 * A `PrismaPromise` is lazy: the data layer's hook — and with it the read of
 * this context — runs when the promise is awaited, not when it is created.
 * `run(ctx, fn)` with a non-async callback (`() => prisma.x.findMany()`)
 * would hand the promise out of the scope unawaited and lose the context
 * (measured both ways, §107 t-704). Awaiting here closes that at the seam
 * rather than with a rule every caller has to remember.
 */
async function settleInside<T>(fn: () => Promise<T>): Promise<T> {
  return await fn();
}

/**
 * Run `fn` as `orgId`. The guards call this for every admitted request;
 * non-request code (a job iterating orgs, a script) calls it directly.
 *
 * The scope covers the whole async subtree of `fn` and nothing outside it —
 * a throw does not leak the context to the next caller, and concurrent work
 * on the same process does not see it (the ALS guarantees, pinned by test).
 */
export function runAsOrg<T>(
  orgId: string,
  fn: () => Promise<T>,
  options: {
    source?: Exclude<TenantContextSource, 'system' | 'implicit'>;
    role?: OrgRole | null;
  } = {}
): Promise<T> {
  return tenantContext.run({ orgId, source: options.source ?? 'job', role: options.role }, () =>
    settleInside(fn)
  );
}

/**
 * Run `fn` with the audited platform bypass — no org.
 *
 * For genuinely global work only: a sweep that must see every org's rows at
 * once, a migration-time backfill. The `reason` is logged at info on every
 * entry, because at `multi` this is the one scope the data layer lets
 * through unscoped (it sets `app.bypass_rls` for the transaction instead of
 * an org), and an unexplained bypass is exactly what an audit needs to find. Prefer {@link forEachOrg}.
 */
export function runAsSystem<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  logger.info('Entering system tenant scope', { reason });
  return tenantContext.run({ orgId: null, source: 'system' }, () => settleInside(fn));
}

/**
 * Run `fn` as the system scope for the ONE read that learns which org a
 * credential belongs to (§107 t-709).
 *
 * A key hash, an embed token, an MCP key, a trigger row, an execution named
 * by an approval token: each is a tenant-owned row that has to be read
 * before any org is known, so the read runs with the bypass — the same
 * scope as {@link runAsSystem}, the same `app.bypass_rls` setter — and the
 * row's org then goes through `resolveCredentialOrg` and `runAsOrg`. The
 * touch that records the credential's last use rides in the same scope, for
 * the same reason.
 *
 * Logged at debug, not info: this runs once per credential-authenticated
 * request, and an info line per entry would drown the signal
 * {@link runAsSystem}'s log exists to give — an unexplained bypass. What an
 * audit needs here is the other half: the sites are enumerable by grep, and
 * nothing but the lookup runs inside one.
 */
export function runAsCredentialLookup<T>(credential: string, fn: () => Promise<T>): Promise<T> {
  logger.debug('Entering system tenant scope for a credential lookup', { credential });
  return tenantContext.run({ orgId: null, source: 'system' }, () => settleInside(fn));
}

/**
 * Run `fn` outside every tenant scope, whatever the caller is inside.
 *
 * **For arming something whose lifetime is the PROCESS's from inside a
 * request** (§108 t-715). An `AsyncLocalStorage` store is captured when
 * `setInterval` is *called*, not when the callback fires, so a repeating timer
 * armed inside `runAsOrg` carries that one org for the life of the process:
 * every line it logs is attributed to whichever org happened to make the first
 * request after boot, and at `multi` every query it makes is scoped to them.
 * Lazily constructed singletons are where this bites, and they are lazy on
 * purpose — a registry filled at boot is empty in the realm that reads it
 * (`platform.seam-realm`), so "construct it eagerly" is not the fix. Arming
 * inside `exit()` is: the callback body needs no change.
 *
 * **Not {@link runAsSystem}**, which is the nearest thing that already
 * existed. That one logs its reason at `info` on every entry — once every few
 * minutes, for the life of the process — and, more importantly, it is the
 * *audited database bypass*: at `multi` it sets `app.bypass_rls`, which is a
 * claim about what the code may read. Arming a timer is not making that claim.
 * This enters no scope at all, so a detached callback that needs an org gets
 * the same refusal as any other path nobody taught to enter one
 * ({@link requireTenantContext} throws at `multi`) rather than silently
 * reading every org's rows.
 *
 * **Detach only what outlives its unit of work.** A timer whose lifetime *is*
 * the work — an execution's lease heartbeat, a webhook delivery retry, an
 * abort timer for one fetch — must KEEP the context it was armed in: its
 * callback writes that org's rows, and detaching it would break the write
 * rather than fix an attribution. The question is not "is this a timer" but
 * "does this outlive the request that armed it".
 *
 * Synchronous and unawaited, unlike the scope-entering runners above: its
 * callers arm timers rather than run queries. A detached *query* is a
 * different request — the audited bypass — so reach for {@link runAsSystem}
 * there and let it be logged.
 */
export function runDetached<T>(fn: () => T): T {
  return tenantContext.exit(fn);
}

/**
 * Run `fn` once per ACTIVE org, each iteration inside its own org scope.
 *
 * Sequential on purpose: per-org batch caps (§108) are meaningless if every
 * org runs at once, and a job that must iterate orgs concurrently can map
 * over the ids itself. Suspended orgs are skipped — nothing should act for an
 * org that has been switched off. The maintenance tick's per-org jobs run
 * through it (`lib/orchestration/maintenance/job-scope.ts`, §108 t-711).
 */
export async function forEachOrg(fn: (orgId: string) => Promise<void>): Promise<void> {
  for (const orgId of await listActiveOrgIds()) {
    await runAsOrg(orgId, () => fn(orgId), { source: 'job' });
  }
}

/**
 * The ids of every ACTIVE org, oldest first — the list {@link forEachOrg}
 * iterates.
 *
 * Exposed so a caller that runs several per-org passes can read it **once**
 * and hand it down (the maintenance tick does: one list per tick rather than
 * one per job). Keeping it here rather than in the caller is what stops the
 * `status: 'ACTIVE'` rule from being written down twice and drifting: a
 * suspended org is skipped, and that must mean the same thing everywhere.
 *
 * `Org` is a system model with no policy, so this read answers every org
 * whatever scope the caller is in.
 */
export async function listActiveOrgIds(): Promise<string[]> {
  const orgs = await prisma.org.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return orgs.map((org) => org.id);
}
