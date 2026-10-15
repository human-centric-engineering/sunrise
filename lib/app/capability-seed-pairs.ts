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
 * since the runner discovers seeds recursively — against a strict mock Prisma
 * client (what it refuses is listed in that test's FORK NOTE),
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

/**
 * Seeds of this fork's that the parity test cannot run under its strict mock
 * client — they use the app's own client, raw SQL (`$executeRaw`) or another
 * call the mock does not model — keyed by path relative to `prisma/seeds/`,
 * each with the reason it writes no capability.
 *
 * The test then lets such a seed throw, use the app client or call what the
 * mock refuses. Whatever it writes past that point goes unchecked, so a seed
 * that writes a capability does not belong here: make it write through the
 * `prisma` it is handed instead. Sunrise core ships `{}`.
 *
 * @example
 * ```ts
 * export const APP_UNCHECKED_SEEDS: Readonly<Record<string, string>> = {
 *   'app/001-vector-index.ts': 'creates a pgvector index with $executeRaw; writes no capability',
 * };
 * ```
 */
export const APP_UNCHECKED_SEEDS: Readonly<Record<string, string>> = {};
