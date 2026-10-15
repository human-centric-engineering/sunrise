/**
 * App capability seed ↔ class pairs, for the parity test.
 *
 * **Fork-owned scaffold** — Sunrise ships an empty array and does NOT change
 * this file after release, so your edits here merge cleanly on upgrade (the
 * stable contract is this file's exports, not their values).
 *
 * Auto-wired: `tests/unit/prisma/seeds/capability-class-seed-parity.test.ts`
 * spreads {@link APP_CAPABILITY_PAIRS} into its own `PAIRS`. Nothing at runtime
 * reads it.
 *
 * ## Why this exists
 *
 * That test holds every capability seed's `functionDefinition` deep-equal to
 * the one its class declares, and fails when the seeds define a capability it
 * has no pair for — the check that stops a new capability going unwatched
 * (#545). It reads your seeds too: `prisma/runner.ts` discovers
 * `prisma/seeds/` recursively, and so does the reader the test uses. So once
 * your capability seeds are visible to it, each needs a pair, and the only
 * other place to put one is `PAIRS` itself — a Sunrise-owned test file, where
 * every row you add is a merge conflict on the next upgrade (#646).
 *
 * Declare your pairs here instead.
 *
 * ## When `seedFile` is required
 *
 * The reader names a capability from its seed's `functionDefinition` when that
 * is an object literal with a literal `name`, or a same-file `const` holding
 * one. Anything else — a definition imported from the class module, read off
 * an instance, or built at runtime — it cannot name, and it reports the file
 * instead. The test then fails that file until some pair declares it as its
 * `seedFile`. Set `seedFile` on the pairs for such a seed; leave it off
 * otherwise.
 *
 * Boundary-clean: no imports at all, so this stays within the `lib/app/**`
 * framework-agnostic boundary. Your entries will import your seed constants
 * and capability classes; that is fine for a file only a test reads.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/database/seeding.md
 */

/** One capability whose seeded definition must equal its class's. */
export interface AppCapabilityPair {
  /** The capability slug; equals its `functionDefinition.name`. */
  slug: string;
  /** What the seed writes — any object carrying the seeded `functionDefinition`. */
  seeded: { functionDefinition: unknown };
  /** A fresh instance of the class the dispatcher runs. */
  instance: { functionDefinition: unknown };
  /**
   * The seed file, relative to `prisma/seeds/` (e.g. `app/030-tasks.ts`).
   * Required only when that seed's definitions are ones the reader cannot
   * name — see "When `seedFile` is required" above.
   */
  seedFile?: string;
}

/**
 * Capability pairs this fork adds to Sunrise's own.
 *
 * Sunrise core ships `[]`.
 *
 * @example
 * ```ts
 * import { WITHDRAW_TASK_IMPL } from '@/prisma/seeds/app/030-tasks';
 * import { WithdrawTaskCapability } from '@/lib/tasks/capabilities/withdraw-task';
 *
 * export const APP_CAPABILITY_PAIRS: readonly AppCapabilityPair[] = [
 *   {
 *     slug: 'withdraw_task',
 *     seeded: WITHDRAW_TASK_IMPL,
 *     instance: new WithdrawTaskCapability(),
 *   },
 * ];
 * ```
 */
export const APP_CAPABILITY_PAIRS: readonly AppCapabilityPair[] = [];
