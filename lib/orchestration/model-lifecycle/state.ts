/**
 * Model lifecycle — the vendor-retirement state of a catalogue model (§136).
 *
 * A vendor retires a model on a day it announces. `AiProviderModel.retiresAt`
 * holds that day; the state below is derived from it at read time, so nothing
 * has to flip a row on a schedule and a reader can never see a stale state.
 *
 * - `current`  — no retirement known (`retiresAt` null).
 * - `retiring` — the vendor still serves it, until `retiresAt`.
 * - `retired`  — `retiresAt` has arrived; calls to it fail at the vendor.
 *
 * Independent of `isActive`, which says whether Sunrise OFFERS the model in
 * its pickers. A retiring model stays active on purpose: an inactive model is
 * dropped from the model registry, so deactivating early would lose its
 * pricing while agents still call it.
 *
 * `checkReplacement` is the one rule for a successor, used by every writer
 * (the admin API, the audit workflow's capability) and by the move (t-1066),
 * which must not trust a stored replacement because the rows it relates can
 * change after it was written.
 *
 * Pure: no database, no Next.js imports.
 */

export type ModelLifecycleState = 'current' | 'retiring' | 'retired';

/** The state of a model with this `retiresAt`, at `now`. */
export function modelLifecycleState(
  model: { retiresAt: Date | null },
  now: Date = new Date()
): ModelLifecycleState {
  if (model.retiresAt === null) return 'current';
  return model.retiresAt.getTime() <= now.getTime() ? 'retired' : 'retiring';
}

/** What `checkReplacement` needs of the model being retired. */
export interface RetiringModelRef {
  id: string;
  providerSlug: string;
  capabilities: readonly string[];
}

/** What `checkReplacement` needs of a proposed successor. */
export interface ReplacementCandidate {
  id: string;
  name: string;
  providerSlug: string;
  capabilities: readonly string[];
  isActive: boolean;
  retiresAt: Date | null;
}

/**
 * Why `candidate` cannot replace `model`, or `null` when it can.
 *
 * - **Same provider** (owner ruling, 2026-11-19): an org's provider approval
 *   (§120) and its own key (§137) are per provider, so a same-provider move
 *   never changes what an org may use or who pays. Another provider is a
 *   provider switch, made per agent in the agent form.
 * - **Not itself**, **active**, and **not retiring or retired**: moving onto a
 *   model that is also going away only schedules a second move, and refusing
 *   a candidate with any retirement date also rules out a cycle of two.
 * - **Every capability the model has**: an agent bound to a model with
 *   `vision` or `embedding` would break on a successor without it. Fix the
 *   successor's capabilities first if the catalogue lags the vendor.
 */
export function checkReplacement(
  model: RetiringModelRef,
  candidate: ReplacementCandidate
): string | null {
  if (candidate.id === model.id) return 'A model cannot replace itself';
  if (candidate.providerSlug !== model.providerSlug) {
    return `The replacement must be on the same provider (${model.providerSlug}); "${candidate.name}" is on ${candidate.providerSlug}`;
  }
  if (!candidate.isActive) return `"${candidate.name}" is turned off in the provider models list`;
  if (candidate.retiresAt !== null) return `"${candidate.name}" is itself being retired`;
  const missing = model.capabilities.filter((c) => !candidate.capabilities.includes(c));
  if (missing.length > 0) {
    return `"${candidate.name}" lacks ${missing.join(', ')}, which this model has`;
  }
  return null;
}

/** `YYYY-MM-DD` as the UTC midnight that begins it, or `null` for a malformed or impossible day. */
export function parseRetirementDate(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  // `2026-02-30` parses to 2 March; a day that does not round-trip is not a day.
  return date.toISOString().slice(0, 10) === day ? date : null;
}
