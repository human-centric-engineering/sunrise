/**
 * Which reserved tiers THIS checkout occupies.
 *
 * **Fork-owned scaffold** — Sunrise ships an empty array and does NOT change
 * this file after release, so your edits here merge cleanly on upgrade (the
 * stable contract is this file's exports, not their values).
 *
 * Auto-wired: read by `tests/unit/reserved-fork-tiers.test.ts`, which holds the
 * `/app` and `/framework` namespaces empty. It subtracts whatever this file
 * declares before asserting.
 *
 * ## Why this exists
 *
 * `reserved-fork-tiers.test.ts` enforces a promise made to forks: *Sunrise core
 * never creates files under these tiers*, which is what lets your files there
 * survive `git merge vX.Y.Z`. Upstream that assertion is exactly right — the
 * repo making the promise is the one being checked.
 *
 * In a fork it inverts. The tiers are *the space the fork was told to use*, so
 * "this directory is empty" is a property only vanilla Sunrise can satisfy, and
 * the failure message names the wrong offender: it reports core as having
 * created files that core did not create. Four of the five known forks fail it
 * on merge — and not only on the `/app` rows. Daybreak is a framework-layer fork
 * and fails the two `/framework` rows for the same reason, so this is not a
 * leaf-fork-only concern.
 *
 * The test cannot work this out for itself: the thing it needs to know — *am I
 * Sunrise, or am I a fork, and which tier do I occupy?* — is not represented
 * anywhere it can read. This file is that representation. Upstream declares
 * nothing and the assertion is unchanged; a fork declares one line here instead
 * of maintaining its own copy of a platform test.
 *
 * ## What you give up by declaring a tier
 *
 * A declared tier is no longer checked **at all** in this checkout, so if a
 * future Sunrise release did add a file under it, this test would not warn you —
 * you would meet it as a merge conflict instead. That is the honest trade, and
 * it is the right way round: the conflict is recoverable and visible, whereas a
 * permanently-red suite trains people to ignore the test. Declare only the tiers
 * you actually occupy, so the rest keep guarding.
 *
 * Boundary-clean: no imports at all, so this stays within the `lib/app/**`
 * framework-agnostic boundary.
 *
 * Full guide: CUSTOMIZATION.md §4 · CUSTOMIZATION.md "The app/platform model"
 */

/**
 * Reserved tiers this repository fills with its own files.
 *
 * Sunrise core ships `[]` — it fills none of them, which is the whole promise.
 *
 * Valid entries are exactly the reserved tiers named in `CLAUDE.md` and
 * `CUSTOMIZATION.md`; anything else is rejected by the test rather than ignored,
 * so a typo fails loudly instead of silently exempting nothing:
 *
 * - `'components/app'`
 * - `'components/framework'`
 * - `'lib/framework'`
 * - `'.context/framework'`
 * - `'.context/app'`
 *
 * @example A leaf fork with its own components and docs
 * ```ts
 * export const occupiedTiers: readonly string[] = ['components/app', '.context/app'];
 * ```
 *
 * @example A framework-layer fork (e.g. Daybreak) sitting between Sunrise and its own leaf forks
 * ```ts
 * export const occupiedTiers: readonly string[] = ['lib/framework', '.context/framework'];
 * ```
 *
 * Note `lib/app/**` is deliberately absent from the list: it is a *scaffold*
 * tier, not an empty reservation. Sunrise ships files there (this one included)
 * and the test has never asserted it empty.
 */
export const occupiedTiers: readonly string[] = [];
