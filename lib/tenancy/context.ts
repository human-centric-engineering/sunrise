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
 * (each credential is bound to an org at mint, t-673). An agent invite token
 * enters nothing: it is a gate the session passes through, checked against
 * the org the guard entered. Background jobs enter it through
 * {@link forEachOrg} / {@link runAsSystem} once §108 wires the tick. Until
 * then those paths run outside any context — which at `single` still
 * answers the install org (see {@link requireTenantContext}) and at `multi`
 * refuses, so a path that was forgotten fails loud rather than reads wide.
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
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '@/lib/env';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import type { OrgRole } from '@/lib/tenancy/roles';

/**
 * How the org was decided. The design record's seven, plus `implicit` — the
 * single-tenant fallback {@link requireTenantContext} answers when nothing
 * entered a context, named so a log line can tell it from a real entry.
 */
export type TenantContextSource =
  'session' | 'api-key' | 'embed-token' | 'mcp-key' | 'resolver' | 'system' | 'job' | 'implicit';

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
 * Run `fn` once per ACTIVE org, each iteration inside its own org scope.
 *
 * Sequential on purpose: per-org batch caps (§108) are meaningless if every
 * org runs at once, and a job that must iterate orgs concurrently can map
 * over the ids itself. Suspended orgs are skipped — nothing should act for an
 * org that has been switched off. Nothing in core calls this yet; §108 wires
 * the maintenance tick through it.
 */
export async function forEachOrg(fn: (orgId: string) => Promise<void>): Promise<void> {
  const orgs = await prisma.org.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const org of orgs) {
    await runAsOrg(org.id, () => fn(org.id), { source: 'job' });
  }
}
