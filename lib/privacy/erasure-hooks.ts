/**
 * Erasure cleanup-hook registry.
 *
 * Lets an app built on Sunrise hook its own user-linked data into the GDPR
 * erasure path (`eraseUser`) for the two things the DB-level FK cascade
 * structurally cannot do:
 *
 *   1. Scrub residual PII left in columns of RETAINED rows. An app table with
 *      an `ON DELETE SET NULL` FK keeps its rows after the user is deleted —
 *      the `userId` link is gone but PII in other columns (an IP, a name
 *      snapshot) is not. Scrub it inside the erasure transaction, before the
 *      user row is deleted, via `scrubInTransaction`.
 *   2. Delete external resources keyed to the user — object-storage blobs,
 *      search-index documents — that no DB cascade can reach. Best-effort,
 *      before the transaction, via `cleanupExternal`.
 *
 * An app registers its hooks from `initAppErasureHooks()` in
 * `lib/app/erasure.ts`, which this module runs once before its first read.
 * Hooks are keyed by `name`, so re-registration under HMR or repeated module
 * imports replaces rather than duplicates.
 *
 * **At `TENANCY_MODE=multi` both phases run as the audited system scope**
 * (`runAsSystem`, §107 t-748), whatever org the caller is in: a person's rows
 * can sit in several orgs, so there is no one org to run as. Filter every
 * query on the `userId` you are handed — an unfiltered one reaches every org's
 * rows. There is no org to ask for: `requireOrgId()` throws, and a
 * tenant-owned row a hook creates is not stamped, so write its `orgId`
 * explicitly, read off the row it relates to. (Not `runAsOrg` inside
 * `scrubInTransaction`: the transaction was opened as the system scope, and an
 * op for another org inside it is refused.) At `single` no scope is entered.
 *
 * This is the seam that keeps seam 6's plain-`String`-FK profile-table pattern
 * GDPR-safe: a `CASCADE` FK is handled automatically by `prisma.user.delete()`,
 * but `SET NULL` retained tables and external blobs need this hook.
 *
 * The same init declares the app's **stale writers** (§122):
 * `registerStaleWriter()` for each app file that writes a column Sunrise's
 * erasure scrubs in place, saying how it knows its copy is stale. Nothing at
 * runtime reads them; `tests/unit/lib/privacy/stale-writers.test.ts` does, and
 * fails on an app writer that has not declared. See `lib/privacy/stale-writers.ts`.
 *
 * @see lib/privacy/erase-user.ts — the consumer that invokes these hooks
 * @see .context/privacy/data-erasure.md — the app-author guide
 */

import type { Prisma } from '@prisma/client';

import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { initAppErasureHooks } from '@/lib/app/erasure';
import type { AnchoredStaleWriter } from '@/lib/privacy/stale-writers';

/**
 * Context passed to {@link ErasureCleanupHook.cleanupExternal}: who is being
 * erased. The same fields the export collector gets (`collectAppSubjectData()`),
 * so a table matched by address can share one match between the two, as core's
 * `contactSubmissionsOf()` does.
 */
export interface ErasureExternalContext {
  /** Id of the user being erased. */
  userId: string;
  /**
   * The account's email as the user row stores it — for app tables keyed by
   * address. Not normalised: match it the way your writer stores addresses
   * (core's `contactSubmissionsUnder()` trims and lower-cases it first).
   */
  email: string;
  /**
   * Whether the account has proven it owns `email`. Match rows by address only
   * when it is `true`: a public form records whatever address was typed, and
   * with verification off anyone can open an account under someone else's —
   * deleting by an unproven address erases a stranger's rows.
   */
  emailVerified: boolean;
}

/** Context passed to {@link ErasureCleanupHook.scrubInTransaction}. */
export interface ErasureTxContext extends ErasureExternalContext {
  /** The erasure transaction client. Use this — not the global `prisma`. */
  tx: Prisma.TransactionClient;
}

/**
 * A unit of app-owned cleanup that runs during {@link eraseUser}. At least one
 * of the two optional phases should be defined, or the hook does nothing.
 */
export interface ErasureCleanupHook {
  /** Unique name. Re-registering the same name replaces the prior hook. */
  name: string;
  /**
   * Best-effort cleanup of external resources (object storage, search indexes)
   * keyed to the user. Runs BEFORE the erasure transaction. A throw is logged
   * and swallowed so it can never block erasure — mirrors Sunrise's own
   * avatar-blob cleanup.
   *
   * **May run more than once, in another process.** An erasure that fails, or
   * runs out of its request's time (t-845), is finished by the maintenance
   * tick, which runs every hook again from the start. Make it idempotent:
   * cleaning up what is already gone must succeed. It is not cut short once
   * started, so keep it to seconds; a slow one spends the request's budget,
   * and the rest of the erasure moves to the tick.
   */
  cleanupExternal?: (ctx: ErasureExternalContext) => Promise<void>;
  /**
   * Scrub residual PII on the app's RETAINED (`ON DELETE SET NULL`) rows. Runs
   * INSIDE the erasure transaction and BEFORE the user row is deleted, so it
   * can still match on `userId` and commits atomically with the delete — a
   * throw rolls the entire erasure back. Use the provided transaction client.
   */
  scrubInTransaction?: (ctx: ErasureTxContext) => Promise<void>;
}

/**
 * On `globalThis`, not module scope (#691). `instrumentation.ts` — and so
 * `initApp()` — loads in a separate module graph from the route handlers that
 * call `eraseUser()`, so a plain `Map` registered from boot was a different
 * object from the one erasure read: the hook never ran, and nothing said so.
 * The shared store keeps forks that register from `initApp()` working; the
 * `lib/app/erasure.ts` seam below is the documented place.
 */
const globalForErasureHooks = globalThis as unknown as {
  sunriseErasureCleanupHooks?: Map<string, ErasureCleanupHook>;
  sunriseStaleWriters?: Map<string, AnchoredStaleWriter>;
};

const hooks: Map<string, ErasureCleanupHook> = (globalForErasureHooks.sunriseErasureCleanupHooks ??=
  new Map<string, ErasureCleanupHook>());

/** Keyed `file#model`, so a re-registration replaces rather than duplicates. */
const staleWriters: Map<string, AnchoredStaleWriter> =
  (globalForErasureHooks.sunriseStaleWriters ??= new Map<string, AnchoredStaleWriter>());

/**
 * Register an app erasure cleanup hook. Idempotent by `name` — re-registering
 * replaces the prior hook (safe under HMR / repeated module imports).
 */
export function registerErasureCleanupHook(hook: ErasureCleanupHook): void {
  hooks.set(hook.name, hook);
}

/**
 * Declare an app file that writes a column Sunrise's erasure scrubs in place,
 * and how it knows its copy is stale (§122). Idempotent by `file` and `model`.
 *
 * Only a settled anchor: `pending` names a Sunrise task and is for Sunrise's
 * own unconverted writers. Read by the stale-writer test, not at runtime.
 */
export function registerStaleWriter(writer: AnchoredStaleWriter): void {
  staleWriters.set(`${writer.file}#${writer.model}`, writer);
}

/**
 * Run the fork's auto-wired hook init exactly once, lazily, before the first
 * read, rolling a partial init back — see `lib/fork-init.ts`.
 *
 * The latch is per module graph while `hooks` is shared, as in
 * `lib/orchestration/chat/context-builder.ts`: re-running an idempotent
 * register-by-name init against the shared store is harmless, and a second
 * graph whose init throws rolls back to what the first registered.
 */
const appInit = createAppInitGate({
  label: 'erasure-hooks: initAppErasureHooks',
  // Rolled back so a half-registered set is never what runs: the log then says
  // plainly that none of the app's cleanup is in place.
  subject: 'app erasure hooks',
  init: initAppErasureHooks,
  snapshot: () => ({ hooks: new Map(hooks), staleWriters: new Map(staleWriters) }),
  restore: (before) => {
    restoreMap(hooks, before.hooks);
    restoreMap(staleWriters, before.staleWriters);
  },
});

/** All registered hooks, in first-registration order. */
export function getErasureCleanupHooks(): ErasureCleanupHook[] {
  appInit.ensure();
  return [...hooks.values()];
}

/** The app's declared stale writers, in first-registration order. */
export function getAppStaleWriters(): AnchoredStaleWriter[] {
  appInit.ensure();
  return [...staleWriters.values()];
}

/** Test-only: clear both registries and re-arm the one-shot app init. */
export function __resetErasureCleanupHooksForTests(): void {
  hooks.clear();
  staleWriters.clear();
  appInit.reset();
}
