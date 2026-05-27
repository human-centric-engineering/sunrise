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
 * An app registers its hooks once at startup (alongside its capability/agent
 * registration). Hooks are keyed by `name`, so re-registration under HMR or
 * repeated module imports replaces rather than duplicates.
 *
 * This is the seam that keeps seam 6's plain-`String`-FK profile-table pattern
 * GDPR-safe: a `CASCADE` FK is handled automatically by `prisma.user.delete()`,
 * but `SET NULL` retained tables and external blobs need this hook.
 *
 * @see lib/privacy/erase-user.ts — the consumer that invokes these hooks
 * @see .context/privacy/data-erasure.md — the app-author guide
 */

import type { Prisma } from '@prisma/client';

/** Context passed to {@link ErasureCleanupHook.cleanupExternal}. */
export interface ErasureExternalContext {
  /** Id of the user being erased. */
  userId: string;
}

/** Context passed to {@link ErasureCleanupHook.scrubInTransaction}. */
export interface ErasureTxContext {
  /** The erasure transaction client. Use this — not the global `prisma`. */
  tx: Prisma.TransactionClient;
  /** Id of the user being erased. */
  userId: string;
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

const hooks = new Map<string, ErasureCleanupHook>();

/**
 * Register an app erasure cleanup hook. Idempotent by `name` — re-registering
 * replaces the prior hook (safe under HMR / repeated module imports).
 */
export function registerErasureCleanupHook(hook: ErasureCleanupHook): void {
  hooks.set(hook.name, hook);
}

/** All registered hooks, in first-registration order. */
export function getErasureCleanupHooks(): ErasureCleanupHook[] {
  return [...hooks.values()];
}

/** Test-only: clear the registry so each test starts from a known state. */
export function __resetErasureCleanupHooksForTests(): void {
  hooks.clear();
}
