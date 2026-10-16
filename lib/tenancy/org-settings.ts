/**
 * `Org.settings` — the platform's own slices of it (§108 t-713, §116 t-724,
 * §120 t-742, §110 t-788).
 *
 * The column has existed since §106 and nothing read or wrote it. This module
 * is the whole of what the platform keeps there: a `retention` slice naming
 * the windows an org wants instead of the global ones, a `platformAgents`
 * marker recording which platform-agent definitions the org was last
 * reconciled against (see {@link readPlatformAgentsMarker}), and a `providers`
 * slice naming the providers a platform admin approved the org for (see
 * {@link readOrgProviderPolicy}), and a `quotas` slice holding the org's own
 * caps (see {@link readOrgQuotas}). Everything else in that JSON belongs to
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
import { isSerializableConflict } from '@/lib/db/serializable-conflict';
import { logger as defaultLogger, type Logger } from '@/lib/logging';
import {
  ORG_QUOTA_KEYS,
  ORG_RETENTION_KEYS,
  orgProviderPolicySchema,
  orgQuotasSchema,
  orgRetentionSchema,
  type OrgProviderPolicy,
  type OrgQuotas,
  type OrgRetentionSlice,
  type OrgSettingsPatch,
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
 * A slice with its `undefined` keys dropped, or `null` when that leaves
 * nothing — the one spelling of "this slice names nothing", for `null`, `{}`
 * and `{ key: undefined }` alike. The last is what a caller produces by
 * forwarding an unset value (`{ monthlyBudgetUsd: plan.cap }` for a plan with
 * no cap), and Zod keeps the key, so counting keys would store it as `{}`.
 */
export function definedEntries<T extends Record<string, unknown>>(
  slice: T | null
): Partial<T> | null {
  if (slice === null) return null;
  const defined = Object.fromEntries(
    Object.entries(slice).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
  return Object.keys(defined).length === 0 ? null : defined;
}

/**
 * Apply a settings patch to an org's stored `settings`, returning the value
 * to write.
 *
 * Each slice the patch names is replaced outright — a PATCH states the org's
 * whole set of windows, or of caps, so merging key-by-key would leave no way
 * to stop setting one. Every other key in `settings` is carried across
 * untouched, which is the half that matters to a fork keeping its own org
 * config there.
 *
 * `null` — and an empty `{}`, which names nothing and therefore says the same
 * thing — removes the slice. When nothing is left the column is set back to
 * SQL `NULL` rather than `{}`, so "this org has never set anything" has one
 * representation instead of two. An `undefined` slice is left alone: that is a
 * patch naming some other slice of the column, not this one.
 *
 * A `settings` column holding something that is not an object — a string, an
 * array — cannot hold slices at all, so it is replaced rather than preserved.
 * Nothing the platform writes can produce that state.
 */
export function applyOrgSettingsPatch(
  current: unknown,
  patch: OrgSettingsPatch
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const base: Record<string, unknown> = isJsonObject(current) ? { ...current } : {};
  const slices: Array<[string, Record<string, unknown> | null | undefined]> = [
    [ORG_RETENTION_KEY, patch.retention],
    [ORG_QUOTAS_KEY, patch.quotas],
  ];

  for (const [key, slice] of slices) {
    if (slice === undefined) continue;
    const stored = definedEntries(slice);
    if (stored === null) {
      delete base[key];
    } else {
      base[key] = stored;
    }
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
 * **It does not clear the policy cache.** `org-provider-policy.ts` caches each
 * org's policy for 60 seconds, so a caller in a running process calls
 * `forgetOrgProviderPolicy(orgId)` after the write, as the grant route does;
 * otherwise a policy read before the write (creating an org reads it, for the
 * cleanup agent's pick) answers for up to a minute. It is not done here
 * because `org-provider-policy.ts` imports this module.
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

/** The key the org's own caps live under inside `Org.settings` (§110 t-788). */
export const ORG_QUOTAS_KEY = 'quotas';

/**
 * Read an org's caps out of its `settings` (§110 t-788).
 *
 * **Per key, and fails open to "no org cap".** A cap that cannot be read is
 * dropped with a warning, as an unreadable retention window is, and an org
 * with no readable cap is limited only by its agents' budgets and the global
 * cap, which still applies to it. The other direction — refusing every turn
 * for an org whose stored JSON is malformed — would take a tenant offline for
 * a bad write, and every writer validates with `orgQuotasSchema` first.
 *
 * @returns the caps this org has readably set; `{}` when it has none.
 */
export function readOrgQuotas(
  settings: unknown,
  context: Record<string, unknown> = {},
  log: Logger = defaultLogger
): OrgQuotas {
  if (!isJsonObject(settings)) return {};
  const slice = settings[ORG_QUOTAS_KEY];
  if (slice === null || slice === undefined) return {};
  if (!isJsonObject(slice)) {
    log.warn('Org quotas slice is not an object; the org has no cap of its own', context);
    return {};
  }

  const quotas: Record<string, number> = {};
  const dropped: string[] = [];
  for (const key of ORG_QUOTA_KEYS) {
    const stored = slice[key];
    if (stored === undefined) continue;
    const parsed = orgQuotasSchema.shape[key].safeParse(stored);
    if (parsed.success && parsed.data !== undefined) quotas[key] = parsed.data;
    else dropped.push(key);
  }

  if (dropped.length > 0) {
    log.warn('Dropped malformed org caps; the org is not capped by them', {
      ...context,
      keys: dropped,
    });
  }
  return quotas;
}

/**
 * Read one org's caps. `Org` is a system model, so this read needs no tenant
 * scope; `checkBudget()` calls it once per chat turn.
 *
 * @returns `{}` when the org does not exist or has set no cap.
 */
export async function loadOrgQuotas(
  orgId: string,
  db: Pick<PrismaClient, 'org'> = prisma,
  log: Logger = defaultLogger
): Promise<OrgQuotas> {
  const org = await db.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  if (!org) return {};
  return readOrgQuotas(org.settings, { orgId }, log);
}

/**
 * Replace an org's caps, preserving every other key in `settings` — the
 * helper a fork's billing or plan code calls to map a plan onto its caps.
 *
 * `quotas` is validated with `orgQuotasSchema`, so an out-of-range or unknown
 * key throws a `ZodError` and nothing is written. `null`, or `{}`, removes the
 * slice and leaves the org with no cap of its own. The slice is replaced
 * whole: a key the call leaves out is removed.
 *
 * **It decides nothing about who may.** It writes whatever it is given;
 * `PATCH /api/v1/admin/orgs/[id]` is where an org's own admins are refused.
 * A fork exposing caps through a surface of its own owns the same check.
 *
 * Through {@link writeSettingsSlice}: a clash with a concurrent settings write
 * throws `P2034` ({@link isSettingsWriteConflict}).
 *
 * **The spend gate and the request counter cache each org's caps**
 * (`spend-caps.ts`, `lib/security/org-request-cap.ts`). Call
 * `forgetOrgCap(orgId)` and `forgetOrgRequestCap(orgId)` after this write so
 * this process enforces the new caps at once; otherwise they take effect
 * within each cache's TTL, as they do in every other process. It does not
 * call them itself, because both modules read their caps through this one.
 *
 * @returns the previous and the stored caps, or `null` when the org does not
 *   exist.
 */
export async function writeOrgQuotas(
  orgId: string,
  quotas: OrgQuotas | null,
  db: Pick<PrismaClient, '$transaction'> = prisma
): Promise<{ previous: OrgQuotas; stored: OrgQuotas } | null> {
  const stored = definedEntries(quotas === null ? null : orgQuotasSchema.parse(quotas));
  const replaced = await writeSettingsSlice(orgId, ORG_QUOTAS_KEY, stored, db);
  if (replaced === null) return null;
  return { previous: readOrgQuotas(replaced.settings, { orgId }), stored: stored ?? {} };
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
 * A `null` value removes the key, and a column left with no keys is set back
 * to SQL `NULL`, as {@link applyOrgSettingsPatch} does.
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
      if (value === null) delete base[key];
      else base[key] = value;
      await tx.org.update({
        where: { id: orgId },
        data: {
          settings:
            Object.keys(base).length === 0 ? Prisma.DbNull : (base as Prisma.InputJsonObject),
        },
      });
      return { settings: row.settings };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

/** Whether `error` is a SERIALIZABLE clash from {@link writeSettingsSlice}. */
export function isSettingsWriteConflict(error: unknown): boolean {
  return isSerializableConflict(error);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
