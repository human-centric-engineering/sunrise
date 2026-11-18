/**
 * Which key a call went out on, from the provider manager to the cost row
 * (§137 t-1046).
 *
 * A call on an org's own vendor key is billed to the org, so its cost row is
 * marked (`AiCostLog.ownKey`) and left out of the org's and the global caps.
 * Only the provider manager's Proxy knows which credential a call used. The
 * row is written later, by whichever of the ~25 `logCost` callers made the
 * call, and those know a model and a provider string that is sometimes the
 * slug, sometimes the provider type and sometimes the model registry's name.
 * Passing the credential through every one of them would miss some, and every
 * fork's own callers.
 *
 * So the Proxy notes each call it sends, by org and model, with the kind of
 * key it used ({@link noteProviderCall}), and `logCost` claims a note for the
 * row it writes ({@link claimOwnKeyCall}). Within one org a provider row's
 * credential is fixed (the org's own key if it holds one, refused otherwise,
 * never the shared key), so the notes for an org and model disagree only when
 * two provider rows serve one model, or around a key being saved or removed.
 *
 * **When the notes disagree, the row is not marked.** Unmarked is the safe
 * side: the spend counts towards the platform's caps, which can only refuse
 * calls early, never let platform spend past a cap. So:
 *
 * - A row is marked only when every live note for its org and model is an
 *   own-key note. It then takes the oldest one.
 * - When every live note is a platform-key one, the row is not marked and
 *   takes the oldest one, so an org's platform calls do not leave notes
 *   behind them.
 * - A row with no live note is not marked: a call older than
 *   {@link OWN_KEY_NOTE_TTL_MS}, a local provider, a capability's cost.
 * - When the notes disagree the row is not marked and nothing is taken. A note
 *   is never matched to a row it may not belong to; the notes go when the rows
 *   that agree with them take them, or expire, so a disagreement can leave an
 *   org's rows for that model unmarked for up to the TTL.
 *
 * The one way a platform row is marked is a cost row for a call that never
 * went through the Proxy, logged for an org and model that had own-key calls
 * in the TTL. Every vendor call core makes goes through the Proxy; that is
 * the outbound-egress guarantee in `llm-providers.md`.
 *
 * Tenancy posture: row-keyed by org id, per process. A call and its cost row
 * are made by the same process, so no other process needs the notes.
 *
 * Platform-agnostic: no Next.js imports.
 */

/** How long a call's note waits for its cost row. Longer than any one vendor call. */
export const OWN_KEY_NOTE_TTL_MS = 15 * 60 * 1000;

/**
 * Notes kept per org and model. Past it the key reads as unclear until the
 * TTL, rather than dropping notes, which could drop a shared-key one.
 */
export const OWN_KEY_NOTES_PER_KEY = 500;

interface Note {
  ownKey: boolean;
  at: number;
}

interface Notes {
  notes: Note[];
  /** Set when notes overflowed: the key reads as unclear until then. */
  unclearUntil: number;
}

const byOrgAndModel = new Map<string, Notes>();

function keyOf(orgId: string, model: string): string {
  // A cuid has no NUL, nor does a model id anyone configures.
  return `${orgId}\u0000${model}`;
}

/** The entry's notes with the expired ones dropped, or nothing if none is left. */
function live(key: string, now: number): Notes | undefined {
  const entry = byOrgAndModel.get(key);
  if (!entry) return undefined;
  const cutoff = now - OWN_KEY_NOTE_TTL_MS;
  const firstLive = entry.notes.findIndex((n) => n.at > cutoff);
  if (firstLive === -1) entry.notes.length = 0;
  else if (firstLive > 0) entry.notes.splice(0, firstLive);
  if (entry.notes.length === 0 && entry.unclearUntil <= now) {
    byOrgAndModel.delete(key);
    return undefined;
  }
  return entry;
}

/**
 * Note a call the provider manager is about to send for `orgId` on `model`,
 * and whether it is going out on the org's own key. Called by the Proxy once a
 * call has passed its gates; never for a call with no org.
 */
export function noteProviderCall(
  orgId: string,
  model: string,
  ownKey: boolean,
  now: number = Date.now()
): void {
  const key = keyOf(orgId, model);
  let entry = live(key, now);
  if (!entry) {
    entry = { notes: [], unclearUntil: 0 };
    byOrgAndModel.set(key, entry);
  }
  if (entry.notes.length >= OWN_KEY_NOTES_PER_KEY) {
    entry.notes.length = 0;
    entry.unclearUntil = now + OWN_KEY_NOTE_TTL_MS;
    return;
  }
  entry.notes.push({ ownKey, at: now });
}

/**
 * Whether the cost row `logCost` is writing for `orgId` and `model` is for a
 * call on the org's own key. See the module header for when it answers `true`;
 * every other answer is `false`, which counts the row as the platform's.
 */
export function claimOwnKeyCall(
  orgId: string | null,
  model: string,
  now: number = Date.now()
): boolean {
  if (!orgId) return false;
  const entry = live(keyOf(orgId, model), now);
  if (!entry || entry.unclearUntil > now || entry.notes.length === 0) return false;
  const ownKey = entry.notes[0].ownKey;
  // Notes that disagree: unclear, so platform spend, and none of them taken.
  if (!entry.notes.every((n) => n.ownKey === ownKey)) return false;
  entry.notes.shift();
  return ownKey;
}

/** Drop every note. For tests, and for the process-state reset. */
export function forgetProviderCallNotes(): void {
  byOrgAndModel.clear();
}
