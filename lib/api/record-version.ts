/**
 * Refusing a stale save: a record's version, and `If-Match` (§122 t-899).
 *
 * An admin opens a form, and the record it shows changes before they save:
 * another admin saves it, or an erasure scrubs a person out of it. Saving the
 * copy the form holds would overwrite that change, and for an erasure it would
 * put the person back. So a save says which version it was loaded at, and is
 * refused when the record has moved on.
 *
 * **The version is the record's content**, not a counter: a hash of the fields
 * a save can write ({@link recordVersion}). Anything that changes them changes
 * it, erasure and raw SQL included, with no column to remember to bump, and a
 * write elsewhere on the row (a scheduler's `nextRunAt`) does not. Two copies
 * with the same content have the same version, so writing one over the other
 * changes nothing.
 *
 * **The protocol.**
 *   • A read returns the version, as a `version` field. Not as the `ETag`: it
 *     covers only what a save writes, so the rest of the body can change
 *     without it.
 *   • A save sends it back as `If-Match`. Without one it is refused with 428
 *     ({@link PreconditionRequiredError}); `*` is refused the same way, since
 *     it would match any version. Required, not optional (owner ruling,
 *     2026-10-23): an optional header is one any client can leave off.
 *   • The route locks the row, computes its current version, and refuses a
 *     mismatch with 412 ({@link StaleRecordError}, code `STALE_RECORD`)
 *     before writing anything. The lock is the one erasure takes, so neither
 *     can land between the other's read and write.
 *   • A create is new intent, not a copy, and is not checked.
 *
 * A fork applies the same three steps to its own records.
 *
 * @see .context/privacy/data-erasure.md — "Saves of a record that moved on"
 */

import { contentHash } from '@/lib/api/etag';
import { PreconditionRequiredError, StaleRecordError } from '@/lib/api/errors';

/**
 * The version of a record whose savable content is `content`: a strong ETag,
 * quoted. Pass the same fields, picked the same way, wherever it is computed.
 */
export function recordVersion(content: unknown): string {
  return `"${contentHash(stableJson(content))}"`;
}

/**
 * JSON with object keys sorted, so a JSONB column's key order cannot change a
 * version. A Date has already become its ISO string by the time the replacer
 * sees it (`toJSON` runs first).
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
        )
      : v
  );
}

/**
 * The versions a save's `If-Match` names. Throws 428 when there is none, when
 * it is `*`, or when it names only weak tags.
 */
export function requireIfMatch(request: Request): string[] {
  const header = request.headers.get('If-Match');
  const versions = (header ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (versions.length === 0 || versions.includes('*')) throw new PreconditionRequiredError();
  // A weak tag is a cache validator (`GET /settings` sends one for its whole
  // body), never a version: sent alone it would be refused as stale on every
  // try, so it is answered as the missing version it is.
  const strong = versions.filter((v) => !v.startsWith('W/'));
  if (strong.length === 0) throw new PreconditionRequiredError();
  return strong;
}

/** Throws 412 unless `current` is among the versions the save was loaded at. */
export function assertCurrentVersion(loadedAt: readonly string[], current: string): void {
  if (!loadedAt.includes(current)) throw new StaleRecordError();
}
