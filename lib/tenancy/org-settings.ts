/**
 * `Org.settings` — the platform's own slice of it (§108 t-713).
 *
 * The column has existed since §106 and nothing read or wrote it. This module
 * is the whole of what the platform keeps there: a `retention` slice naming
 * the windows an org wants instead of the global ones. Everything else in that
 * JSON belongs to whoever put it there — a fork's own org-level config — and
 * the write path below preserves it rather than replacing the object.
 *
 * **Validate on read, and degrade to inherit — one key at a time.** The
 * column is admin-written JSON, so a stored value is not trusted on the way
 * back out: a malformed window drops to "inherit the global one" with a logged
 * warning rather than throwing out of the retention sweep. That is
 * `resolvePersistedScope`'s contract (`lib/orchestration/scope.ts`), and the
 * reasoning transfers: every writer of this key validates on write, and
 * wedging an install's pruning on one bad row is the worse failure.
 *
 * **Per key, not per slice, because the blast radius is deletion.** The write
 * schema is `.strict()` — an unknown key there is a typo worth a 400. Reading
 * that way would mean one unreadable key discarding the org's other four, so
 * an org that asked to keep executions for a year would silently inherit the
 * platform's 90 days and lose nine months of history to a validation
 * technicality. A release that changes the slice's shape would do it to every
 * org at once. So the read takes each key on its own merits and ignores what
 * it does not recognise: a key that cannot be read is *absent*, which is
 * already the vocabulary's word for "inherit".
 *
 * **Tenancy posture:** stateless — nothing here is cached. {@link
 * loadOrgRetention} filters on the org id itself, which is unique across orgs,
 * so it is a row-keyed read in the sense `lib/tenancy/process-state.ts`
 * defines: it answers the same question under any scope, and the answer cannot
 * come from another org.
 *
 * @see lib/validations/tenancy.ts — the slice's schema and its bounds
 * @see lib/orchestration/retention.ts — the sweep that overlays it on the global row
 * @see .context/tenancy/identity.md — what `Org.settings` is, and whose the rest of it is
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger as defaultLogger, type Logger } from '@/lib/logging';
import {
  ORG_RETENTION_KEYS,
  orgRetentionSchema,
  type OrgRetentionSlice,
} from '@/lib/validations/tenancy';

/** The key the platform owns inside `Org.settings`. */
export const ORG_RETENTION_KEY = 'retention';

/**
 * Validate a stored `settings.retention` slice before trusting it.
 *
 * @param settings The org's whole `settings` column, as Prisma returns it.
 * @param context  Structured fields identifying the row, logged if a window is
 *   malformed (e.g. `{ orgId }`).
 * @param log      Logger for the malformed-drop warning.
 * @returns The windows this org has readably chosen, or `null` when it has
 *   chosen none — the column unset, no `retention` key, a `retention` that is
 *   not an object, or every key in it unreadable. All of those mean "inherit
 *   every global window".
 */
export function readOrgRetention(
  settings: unknown,
  context: Record<string, unknown> = {},
  log: Logger = defaultLogger
): OrgRetentionSlice | null {
  if (!isJsonObject(settings)) {
    // `null`/`undefined` are the normal unset states and say nothing. Anything
    // else in the column is a fork's, and is not this module's to police
    // beyond declining to read a slice out of it.
    if (settings !== null && settings !== undefined) {
      log.warn('Org settings is not an object; no retention slice read', context);
    }
    return null;
  }

  const slice = settings[ORG_RETENTION_KEY];
  if (slice === null || slice === undefined) return null;
  if (!isJsonObject(slice)) {
    log.warn('Org retention slice is not an object; inheriting every global window', context);
    return null;
  }

  const windows: Record<string, number | null> = {};
  const dropped: string[] = [];

  for (const key of ORG_RETENTION_KEYS) {
    const stored = slice[key];
    if (stored === undefined) continue;
    const parsed = orgRetentionSchema.shape[key].safeParse(stored);
    if (parsed.success) {
      // `.optional()` on the shape means a parsed `undefined` is possible in
      // principle; it cannot be one here, since `undefined` was skipped above.
      if (parsed.data !== undefined) windows[key] = parsed.data;
    } else {
      dropped.push(key);
    }
  }

  if (dropped.length > 0) {
    log.warn('Dropped malformed org retention windows; those inherit the global ones', {
      ...context,
      keys: dropped,
    });
  }

  return Object.keys(windows).length > 0 ? windows : null;
}

/**
 * Read one org's retention slice.
 *
 * One indexed `findUnique` — the retention sweep calls it once per org per
 * hour. `Org` is a system model (`lib/tenancy/classification.ts`), so this
 * read needs no tenant scope and takes none.
 */
export async function loadOrgRetention(
  orgId: string,
  db: Pick<PrismaClient, 'org'> = prisma,
  log: Logger = defaultLogger
): Promise<OrgRetentionSlice | null> {
  const org = await db.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  if (!org) return null;
  return readOrgRetention(org.settings, { orgId }, log);
}

/**
 * Apply a retention patch to an org's stored `settings`, returning the value
 * to write.
 *
 * Replaces the `retention` slice outright — a PATCH states the org's whole
 * set of windows, so merging key-by-key would leave no way to stop overriding
 * one. Every other key in `settings` is carried across untouched, which is
 * the half that matters to a fork keeping its own org config there.
 *
 * `null` removes the slice. When nothing is left the column is set back to
 * SQL `NULL` rather than `{}`, so "this org has never set anything" has one
 * representation instead of two.
 *
 * A `settings` column holding something that is not an object — a string, an
 * array — cannot hold slices at all, so it is replaced rather than preserved.
 * Nothing the platform writes can produce that state.
 */
export function applyRetentionPatch(
  current: unknown,
  slice: OrgRetentionSlice | null
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const base: Record<string, unknown> = isJsonObject(current) ? { ...current } : {};

  if (slice === null) {
    delete base[ORG_RETENTION_KEY];
  } else {
    base[ORG_RETENTION_KEY] = slice;
  }

  if (Object.keys(base).length === 0) return Prisma.DbNull;
  return base as Prisma.InputJsonObject;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
