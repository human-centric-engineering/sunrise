/**
 * App tenancy classification seam — which of your models are system rows,
 * shared settings, or rows a person owns outside any org.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's `initAppTenancyClassification` export, not its body).
 * Treat it like the other `lib/app/*` seams.
 *
 * Every Prisma model is tenant-owned (it carries `orgId`), system, shared
 * settings, or user-owned, and the coverage guard
 * (`tests/unit/lib/tenancy/model-classification.test.ts`) fails naming any
 * model that is none of them — yours included. A model with `orgId` needs
 * nothing here. Classify the rest of yours here instead of editing core's lists
 * in `lib/tenancy/classification.ts`, which conflicts at every upgrade.
 *
 * Auto-wired: `lib/tenancy/classification.ts` runs this once, lazily, before
 * its first read — in whichever runtime builds the Prisma client — so there is
 * no registration step to remember.
 *
 * Full guide: .context/architecture/multi-tenancy.md "Classifying your models"
 */

/**
 * Classify your tier's models that carry no `orgId`.
 *
 * ```ts
 * import { registerAppTenancyClassification } from '@/lib/tenancy/classification';
 *
 * export function initAppTenancyClassification(): void {
 *   registerAppTenancyClassification({
 *     tier: 'app',
 *     // A person's own rows, across orgs: no orgId, and a link to a user.
 *     userOwned: ['Kit', 'PracticeRun'],
 *     // Install-wide data every org reads; routes writing it declare
 *     // `writesSharedSettings`.
 *     globalConfig: ['LineageNode'],
 *     // Rows that decide or record tenancy (identity bookkeeping, audit).
 *     system: ['ReservedUsername'],
 *   });
 * }
 * ```
 *
 * Classify only your own models, and never one that carries `orgId` as
 * system. The coverage guard fails on either: the first would move a core
 * model, the second would leave a tenant's rows readable across orgs.
 *
 * Call `registerAppTenancyClassification` only inside this function, never at
 * module scope: this file is loaded while `lib/tenancy/classification.ts` is
 * still loading, and a module-scope call crashes it.
 *
 * A framework tier registers with `tier: 'framework'`, from a function the
 * leaf's `initAppTenancyClassification()` calls — not from `initFramework()` at
 * boot, which runs in a different runtime from the one that reads this.
 *
 * Do not import the Prisma client (`@/lib/db`) from here: this runs while that
 * client is being built.
 */
export function initAppTenancyClassification(): void {
  // No app tenancy classifications by default.
}
