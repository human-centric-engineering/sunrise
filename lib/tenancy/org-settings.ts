/**
 * `Org.settings` — the platform's own slices of it (§108 t-713, §116 t-724,
 * §120 t-742).
 *
 * The column has existed since §106 and nothing read or wrote it. This module
 * is the whole of what the platform keeps there: a `retention` slice naming
 * the windows an org wants instead of the global ones, a `platformAgents`
 * marker recording which platform-agent definitions the org was last
 * reconciled against (see {@link readPlatformAgentsMarker}), and a `providers`
 * slice naming the providers a platform admin approved the org for (see
 * {@link readOrgProviderPolicy}). Everything else in that JSON belongs to
 * whoever put it there — a fork's own org-level config — and every write path
 * below preserves it rather than replacing the object.
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
 * **The provider slice is the exception, and fails closed.** There, the
 * degraded answer is not a global default but "no provider", because the
 * blast radius of reading it wrong is an org's data reaching a vendor it was
 * never approved for. See {@link readOrgProviderPolicy}.
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
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger as defaultLogger, type Logger } from '@/lib/logging';
import {
  ORG_RETENTION_KEYS,
  orgProviderPolicySchema,
  orgRetentionSchema,
  type OrgProviderPolicy,
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
 * `null` — and an empty `{}`, which names no window and therefore says the
 * same thing — removes the slice. When nothing is left the column is set back
 * to SQL `NULL` rather than `{}`, so "this org has never set anything" has one
 * representation instead of two. `undefined` leaves the slice alone: that is a
 * patch naming some other slice of the column, not this one.
 *
 * A `settings` column holding something that is not an object — a string, an
 * array — cannot hold slices at all, so it is replaced rather than preserved.
 * Nothing the platform writes can produce that state.
 */
export function applyRetentionPatch(
  current: unknown,
  slice: OrgRetentionSlice | null | undefined
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const base: Record<string, unknown> = isJsonObject(current) ? { ...current } : {};

  if (slice === undefined) {
    // A patch that names other slices and not this one. Nothing to do here;
    // the column is written back as it stands, so the caller's log line is
    // true about what it changed.
  } else if (slice === null || Object.keys(slice).length === 0) {
    // `{}` names no window, so it says exactly what `null` says. Storing it
    // would leave the column non-NULL for ever and give "this org has set
    // nothing" a second spelling.
    delete base[ORG_RETENTION_KEY];
  } else {
    base[ORG_RETENTION_KEY] = slice;
  }

  if (Object.keys(base).length === 0) return Prisma.DbNull;
  return base as Prisma.InputJsonObject;
}

/** The key the platform-agent reconcile owns inside `Org.settings`. */
export const ORG_PLATFORM_AGENTS_KEY = 'platformAgents';

const platformAgentsMarkerSchema = z.object({
  hash: z.string().min(1),
  slugs: z.array(z.string()),
});

/**
 * What the platform-agent reconcile last wrote into an org (§116 t-724).
 *
 * `hash` is the registry digest it reconciled against, so the maintenance job
 * can tell an org that is behind the running code without reading its agents.
 * `slugs` are the platform agents it materialised there, and they are what
 * lets a later reconcile deactivate an agent the registry dropped while
 * leaving every other `isSystem` agent — a fork's own seeded one — alone.
 */
export type PlatformAgentsMarker = z.infer<typeof platformAgentsMarkerSchema>;

/**
 * Read the marker out of an org's `settings`. Anything unreadable is `null`,
 * which means "never reconciled": the job reconciles the org, and nothing is
 * deactivated because nothing is known to have been placed.
 */
export function readPlatformAgentsMarker(settings: unknown): PlatformAgentsMarker | null {
  if (!isJsonObject(settings)) return null;
  const parsed = platformAgentsMarkerSchema.safeParse(settings[ORG_PLATFORM_AGENTS_KEY]);
  return parsed.success ? parsed.data : null;
}

/** One org's marker. `Org` is a system model, so no tenant scope is needed. */
export async function loadPlatformAgentsMarker(
  orgId: string,
  db: Pick<PrismaClient, 'org'> = prisma
): Promise<PlatformAgentsMarker | null> {
  const org = await db.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  return org ? readPlatformAgentsMarker(org.settings) : null;
}

/**
 * Store the marker, preserving every other key in `settings`.
 *
 * Through {@link writeSettingsSlice}, the same serializable read-modify-write
 * as `updateOrg`'s retention patch. A clash fails the later writer rather than
 * losing either; the reconcile is re-run by the next maintenance tick.
 */
export async function writePlatformAgentsMarker(
  orgId: string,
  marker: PlatformAgentsMarker,
  db: Pick<PrismaClient, '$transaction'> = prisma
): Promise<void> {
  await writeSettingsSlice(orgId, ORG_PLATFORM_AGENTS_KEY, marker, db);
}

/** The key the provider policy owns inside `Org.settings` (§120 t-742). */
export const ORG_PROVIDERS_KEY = 'providers';

/** What an org that has never been granted anything holds: no provider. */
const NO_PROVIDERS: OrgProviderPolicy = { approved: [] };

/**
 * Read an org's provider policy out of its `settings`.
 *
 * **Fails closed, unlike retention.** An unreadable retention window degrades
 * to the global one, because the cost of that failure is pruning. An
 * unreadable provider policy degrades to *nothing approved*, because the
 * alternative is sending an org's data to a vendor nobody approved it for. A
 * slice that is absent is the same answer for a different reason: every org
 * starts with no provider until a platform admin grants one.
 *
 * The whole slice is validated as one value rather than per key: half a
 * policy — the approved set without its jurisdiction restriction — is wider
 * than the policy that was written.
 */
export function readOrgProviderPolicy(
  settings: unknown,
  context: Record<string, unknown> = {},
  log: Logger = defaultLogger
): OrgProviderPolicy {
  if (!isJsonObject(settings)) return NO_PROVIDERS;
  const slice = settings[ORG_PROVIDERS_KEY];
  if (slice === undefined || slice === null) return NO_PROVIDERS;
  const parsed = orgProviderPolicySchema.safeParse(slice);
  if (parsed.success) return parsed.data;
  log.warn('Org provider policy is malformed; treating the org as approved for no provider', {
    ...context,
    issues: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
  });
  return NO_PROVIDERS;
}

/**
 * Replace an org's provider policy, preserving every other key in
 * `settings`, and return what it replaced.
 *
 * Through {@link writeSettingsSlice}: a clash with a concurrent settings write
 * throws `P2034`, which the route answers with a 409.
 *
 * @returns the previous and the stored policy, or `null` when the org does
 *   not exist.
 */
export async function writeOrgProviderPolicy(
  orgId: string,
  policy: OrgProviderPolicy,
  db: Pick<PrismaClient, '$transaction'> = prisma
): Promise<{ previous: OrgProviderPolicy; stored: OrgProviderPolicy } | null> {
  // `null` jurisdictions and an absent key say the same thing; store one.
  const stored: OrgProviderPolicy = policy.jurisdictions
    ? { approved: policy.approved, jurisdictions: policy.jurisdictions }
    : { approved: policy.approved };
  const replaced = await writeSettingsSlice(orgId, ORG_PROVIDERS_KEY, stored, db);
  if (replaced === null) return null;
  return { previous: readOrgProviderPolicy(replaced.settings, { orgId }), stored };
}

/**
 * Replace one platform-owned key in an org's `settings`, preserving every
 * other key — a fork's included.
 *
 * A read-modify-write in a SERIALIZABLE transaction: two writers each reading
 * the object before the other wrote would drop one slice. A clash fails the
 * later writer with Prisma's `P2034` rather than losing either; a route maps
 * it to a 409 with {@link isSettingsWriteConflict}.
 *
 * @returns the column as it stood before the write, so a caller can say what
 *   it replaced; `null` when the org does not exist, and nothing was written.
 */
async function writeSettingsSlice(
  orgId: string,
  key: string,
  value: unknown,
  db: Pick<PrismaClient, '$transaction'>
): Promise<{ settings: unknown } | null> {
  return db.$transaction(
    async (tx) => {
      const row = await tx.org.findUnique({ where: { id: orgId }, select: { settings: true } });
      if (!row) return null;
      const base: Record<string, unknown> = isJsonObject(row.settings) ? { ...row.settings } : {};
      base[key] = value;
      await tx.org.update({
        where: { id: orgId },
        data: { settings: base as Prisma.InputJsonObject },
      });
      return { settings: row.settings };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

/** Whether `error` is a SERIALIZABLE clash from {@link writeSettingsSlice}. */
export function isSettingsWriteConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
