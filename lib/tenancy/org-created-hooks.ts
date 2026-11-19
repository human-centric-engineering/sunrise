/**
 * Org-created hook registry (§134 t-1061, sunrise#1270).
 *
 * Lets an app set a new org up — grant it an AI provider, record how it is
 * served, give it a starting package — for **every** new org, however it was
 * made, without editing a platform file. Before this an app could do that only
 * in a create step of its own, so an org platform staff made from Sunrise's
 * admin skipped it and could call no AI provider.
 *
 * **Every org passes through `createOrg()`** (`lib/tenancy/lifecycle.ts`), the
 * one place an org row is written, so a dispatch there covers the admin route
 * and a fork calling it (and, once §134 t-1062 ships, self-serve signup).
 *
 * **Hooks run after the create commits, never inside it.** A hook that could
 * fail the create would let a fault in app code (or a vendor's outage) refuse
 * a signup. But a failed hook must not be silent either, which is what #1270
 * is about. So `createOrg()` records the hooks owed in the same INSERT as the
 * org (`Org.settings.orgCreated`), each success is taken off that list, and the
 * `orgCreatedHooks` maintenance job re-runs whatever is still owed. A hook can
 * therefore run more than once for one org, and **must be idempotent**.
 *
 * App hooks run before the platform agents are reconciled into the new org,
 * so a provider an app grants here is what the agents' bindings are picked
 * from.
 *
 * Each hook runs inside the new org's tenant scope (`runAsOrg`), so the rows
 * it writes are stamped with the org, and are confined to it at `multi`.
 *
 * Hooks run one at a time, in registration order, each bounded by
 * {@link ORG_CREATED_HOOK_TIMEOUT_MS}, so a create is never held open by a hung
 * vendor call.
 *
 * Hooks are keyed, so re-registering a key replaces the hook. A key that is
 * owed but not registered in this process is left owed rather than dropped:
 * during a rolling deploy, the next run may be on an instance that has it.
 *
 * The retry job runs over ACTIVE orgs only (`forEachOrg`), so an org
 * suspended while it still owes hooks gets them when it is reinstated.
 *
 * @see lib/app/org-created.ts — the fork-owned registration seam
 * @see lib/tenancy/lifecycle.ts — `createOrg()`, the producer
 * @see .context/tenancy/identity.md — the guide
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { initAppOrgCreatedHooks } from '@/lib/app/org-created';
import { runAsOrg } from '@/lib/tenancy/context';
import { withTimeout } from '@/lib/utils/with-timeout';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import {
  clearOrgCreatedOwed,
  readOrgCreatedOwed,
  type OrgCreatedSource,
} from '@/lib/tenancy/org-settings';

export type { OrgCreatedSource } from '@/lib/tenancy/org-settings';

/** The new org, as an org-created hook is told it. */
export interface OrgCreatedContext {
  /** The new org's id. */
  orgId: string;
  /** Its slug, as it stands when the hook runs. */
  slug: string;
  /** Its display name, as it stands when the hook runs. */
  name: string;
  /**
   * How it was made: `admin` from Sunrise's admin, `app` by an app's own call
   * to `createOrg()`. `signup` is reserved for Sunrise's self-serve signup
   * (§134 t-1062), which does not create orgs yet.
   */
  source: OrgCreatedSource;
  /**
   * Its founding OWNER, when it has one. On the first run, the owner the
   * create named; on a retry, the org's earliest OWNER. `null` for an org
   * created with no owner.
   */
  ownerUserId: string | null;
  /** False on the run straight after the create; true when the maintenance job re-runs it. */
  retry: boolean;
  /**
   * Aborts when the hook has run for {@link ORG_CREATED_HOOK_TIMEOUT_MS}. The
   * run stops waiting then either way, and the hook stays owed; pass it to a
   * vendor call so the call stops too.
   */
  signal: AbortSignal;
}

/** A unit of app-owned setup that runs for every new org. Must be idempotent. */
export type OrgCreatedHook = (ctx: OrgCreatedContext) => Promise<void> | void;

const hooks = new Map<string, OrgCreatedHook>();

/**
 * Register an org-created hook. Idempotent by `key`: re-registering replaces
 * the hook. Call it inside `initAppOrgCreatedHooks()` in
 * `lib/app/org-created.ts`, not at that module's top level, so a throw
 * part-way through rolls back.
 *
 * The key is recorded on each new org until the hook succeeds there, so keep
 * it stable: renaming it drops it from orgs still owed the old one.
 */
export function registerOrgCreatedHook(key: string, hook: OrgCreatedHook): void {
  hooks.set(key, hook);
}

/**
 * Run the fork's init once, lazily, before the first read — see
 * `lib/fork-init.ts`. Rolled back on a throw: a hook left live by a partial
 * init would set up every new org from a config the log says did not load.
 */
const appInit = createAppInitGate({
  label: 'org-created: initAppOrgCreatedHooks',
  subject: 'app hooks',
  init: initAppOrgCreatedHooks,
  snapshot: () => new Map(hooks),
  restore: (before) => restoreMap(hooks, before),
});

/** Test-only: drop every hook and re-arm the one-shot init. Not exported from any barrel. */
export function __resetOrgCreatedHooksForTests(): void {
  hooks.clear();
  appInit.reset();
}

/**
 * The keys of every registered hook: what a new org is owed. Empty when the
 * app registers none, and then `createOrg()` writes nothing extra.
 */
export function orgCreatedHookKeys(): string[] {
  appInit.ensure();
  return [...hooks.keys()];
}

/** What one run over an org's owed hooks did. */
export interface OrgCreatedRunResult {
  /** Hooks that ran and succeeded, and are no longer owed. */
  succeeded: number;
  /** Hooks that threw or timed out, and stay owed. */
  failed: number;
  /**
   * Owed keys this process has no hook for. Left owed, not run: during a
   * rolling deploy the next run may be on an instance that has it.
   */
  unregistered: number;
}

const NOTHING_RAN: OrgCreatedRunResult = { succeeded: 0, failed: 0, unregistered: 0 };

/**
 * How long one hook may run before it is given up on for this run and left
 * owed. A create waits for the hooks, so one hung on a vendor must not hold
 * the request open; the hook is told through `signal` so it can stop.
 */
export const ORG_CREATED_HOOK_TIMEOUT_MS = 10_000;

/**
 * Run every hook an org is still owed, one at a time in the order they were
 * registered, and take the ones that succeeded off its list.
 *
 * **One at a time** because a hook that writes `Org.settings` (switches, a
 * provider grant) does so in a SERIALIZABLE transaction on the org row: two
 * at once would make one of them fail. Registration order also lets an app
 * rely on one hook's setup being there for the next.
 *
 * Never throws: a hook's throw or timeout is logged at `error` and leaves it
 * owed, and a failure to read the org or to record the successes is logged
 * too, since the maintenance job asks again. With no hook registered it
 * returns at once, without reading the org.
 *
 * @param known What the caller already knows, to save the reads on the run
 *   straight after a create: the founding owner it named. Absent on a retry,
 *   which reads the org's earliest OWNER.
 */
export async function runOrgCreatedHooks(
  orgId: string,
  known?: { ownerUserId: string | null }
): Promise<OrgCreatedRunResult> {
  appInit.ensure();
  if (hooks.size === 0) return NOTHING_RAN;

  try {
    const org = await prisma.org.findUnique({
      where: { id: orgId },
      select: { slug: true, name: true, settings: true },
    });
    const owed = org ? readOrgCreatedOwed(org.settings) : null;
    if (!org || !owed) return NOTHING_RAN;

    const ownerUserId = known ? known.ownerUserId : await foundingOwnerOf(orgId);
    const base = {
      orgId,
      slug: org.slug,
      name: org.name,
      source: owed.source,
      ownerUserId,
      retry: known === undefined,
    };

    const owedKeys = new Set(owed.owed);
    const runnable = [...hooks.entries()].filter(([key]) => owedKeys.has(key));
    const unregistered = owed.owed.filter((key) => !hooks.has(key));
    if (unregistered.length > 0) {
      // Not dropped: an instance on another version may have it. A key no
      // version registers any more stays owed and costs nothing.
      logger.debug('org-created: owed hooks not registered in this process; left owed', {
        orgId,
        hooks: unregistered,
      });
    }

    const succeeded = await runAsOrg(orgId, async () => {
      const done: string[] = [];
      for (const [key, hook] of runnable) {
        try {
          await withTimeout(ORG_CREATED_HOOK_TIMEOUT_MS, `org-created hook ${key}`, (signal) =>
            Promise.resolve(hook({ ...base, signal }))
          );
          done.push(key);
        } catch (err) {
          logger.error('org-created hook failed; the maintenance job retries it', {
            hook: key,
            orgId,
            retry: base.retry,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return done;
    });

    try {
      await clearOrgCreatedOwed(orgId, succeeded);
    } catch (err) {
      // The hooks ran; only the record of it failed, so they run again.
      logger.warn('org-created: could not record the hooks that succeeded; they will run again', {
        orgId,
        hooks: succeeded,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      succeeded: succeeded.length,
      failed: runnable.length - succeeded.length,
      unregistered: unregistered.length,
    };
  } catch (err) {
    logger.error('org-created hooks could not be run for an org; the maintenance job retries', {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NOTHING_RAN;
  }
}

/** The org's earliest OWNER, or `null` when it has none. */
async function foundingOwnerOf(orgId: string): Promise<string | null> {
  const owner = await prisma.orgMembership.findFirst({
    where: { orgId, role: ORG_OWNER_ROLE },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  });
  return owner?.userId ?? null;
}
