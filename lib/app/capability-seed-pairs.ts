/**
 * Which capability class goes with which slug, for this fork's capability seeds.
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
 * That test runs every seed under `prisma/seeds/` — yours included,
 * since the runner discovers seeds recursively — against a mock Prisma client,
 * captures each capability the seeds write, and requires the written
 * `functionDefinition` to equal the one its class declares (#545). A captured
 * capability with no pair fails it, so every capability you seed needs one.
 * The only other place to put it is `PAIRS` itself — a Sunrise-owned test
 * file, where every row you add is a merge conflict on the next upgrade (#646).
 *
 * Declare your pairs here instead. A pair names the slug and the class; the
 * test supplies what the seed wrote, so nothing here imports a seed file.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/database/seeding.md
 */

/** One capability slug and the class whose definition its seed must write. */
export interface AppCapabilityPair {
  /** The capability slug; also its `functionDefinition.name`. */
  slug: string;
  /** A fresh instance of the class the dispatcher runs for that slug. */
  instance: { functionDefinition: unknown };
}

/**
 * Capability pairs this fork adds to Sunrise's own.
 *
 * Sunrise core ships `[]`.
 *
 * @example
 * ```ts
 * import { WithdrawTaskCapability } from '@/lib/tasks/capabilities/withdraw-task';
 *
 * export const APP_CAPABILITY_PAIRS: readonly AppCapabilityPair[] = [
 *   { slug: 'withdraw_task', instance: new WithdrawTaskCapability() },
 * ];
 * ```
 */
export const APP_CAPABILITY_PAIRS: readonly AppCapabilityPair[] = [];
