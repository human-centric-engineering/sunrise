/**
 * The retention windows, and whose they are (§108 t-711, t-713).
 *
 * A leaf module on purpose. The prunes themselves live in
 * `lib/orchestration/retention.ts`, which reaches `McpServerConfig` — and
 * through it `SUNRISE_VERSION` — for the MCP audit window. The org admin route
 * needs the *windows* to check an org's slice against what it would inherit,
 * and nothing else in that graph; importing the sweep for two numbers put an
 * org route inside the version-disclosure closure, which
 * `tests/unit/sunrise-version-disclosure.test.ts` caught. Splitting the read
 * out is the answer to that rather than widening the closure's allowlist.
 *
 * `retention.ts` re-exports everything here, so this file is a place the
 * symbols live rather than a second surface to know about.
 *
 * @see lib/tenancy/org-settings.ts — the org's slice, and the rules for reading it
 * @see .context/orchestration/retention.md — the precedence table
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { loadOrgRetention } from '@/lib/tenancy/org-settings';
import type { OrgRetentionSlice } from '@/lib/validations/tenancy';

/**
 * The global retention windows the TENANT sweep needs, in days. `null` = that
 * class is never pruned.
 *
 * `auditLogRetentionDays` is deliberately absent: the admin audit log moved to
 * `enforceSystemRetentionPolicies` (§108 t-711), so selecting it here would
 * read a column this sweep never uses — and it is why an org's slice names
 * five windows rather than six.
 */
export interface RetentionWindows {
  webhookRetentionDays: number | null;
  webhookDlqRetentionDays: number | null;
  costLogRetentionDays: number | null;
  executionRetentionDays: number | null;
  evaluationRetentionDays: number | null;
}

const NO_RETENTION_WINDOWS: RetentionWindows = {
  webhookRetentionDays: null,
  webhookDlqRetentionDays: null,
  costLogRetentionDays: null,
  executionRetentionDays: null,
  evaluationRetentionDays: null,
};

/**
 * The window names this sweep uses, derived from the shape above rather than
 * written out, so the list cannot fall behind the interface.
 *
 * It is what an org's `settings.retention` slice may name —
 * `ORG_RETENTION_KEYS` in `lib/validations/tenancy.ts` is the same set, and a
 * test holds the two level. A window added to the global row and not to the
 * slice would be one no org could override, silently.
 */
export const RETENTION_WINDOW_KEYS = Object.keys(
  NO_RETENTION_WINDOWS
) as readonly (keyof RetentionWindows)[];

/**
 * Read the tenant sweep's retention windows in **one** query, **throwing** if
 * the row cannot be read.
 *
 * The caller that needs this rather than {@link loadRetentionWindows} is a
 * *write guard*: the org PATCH checks an org's slice against the windows it
 * would inherit, and swallowing the read there turns "I could not look" into
 * "there is nothing to check", which lets through exactly the configuration
 * the guard exists to refuse (`.context/architecture/checks.md`). Failing the
 * request costs the caller nothing real — the write it was about to make would
 * have hit the same database a moment later.
 *
 * The sweep's swallow is the opposite trade and still right: there, not
 * knowing means not deleting.
 */
export async function readRetentionWindows(): Promise<RetentionWindows> {
  const row = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: {
      webhookRetentionDays: true,
      webhookDlqRetentionDays: true,
      costLogRetentionDays: true,
      executionRetentionDays: true,
      evaluationRetentionDays: true,
    },
  });
  if (!row) return NO_RETENTION_WINDOWS;
  return {
    webhookRetentionDays: row.webhookRetentionDays ?? null,
    webhookDlqRetentionDays: row.webhookDlqRetentionDays ?? null,
    costLogRetentionDays: row.costLogRetentionDays ?? null,
    executionRetentionDays: row.executionRetentionDays ?? null,
    evaluationRetentionDays: row.evaluationRetentionDays ?? null,
  };
}

/**
 * The sweep's read: {@link readRetentionWindows}, degrading to "no windows
 * configured" on a read failure.
 *
 * That matches `resolveRetentionDays`' swallow-on-error contract — a transient
 * settings-read failure skips the prunes rather than throwing out of the sweep
 * — and it is the safe direction here, because a window nobody could read
 * deletes nothing.
 *
 * `resolveRetentionDays` reads the same singleton row once per prune, which
 * cost a sweep seven or eight round-trips to fetch a handful of columns
 * (#442). This is a hoist, not a cache: every prune already takes an explicit
 * window as its first parameter, the sweep just never passed one.
 */
export async function loadRetentionWindows(): Promise<RetentionWindows> {
  try {
    return await readRetentionWindows();
  } catch {
    return NO_RETENTION_WINDOWS;
  }
}

/**
 * What the sweep actually prunes on: the global windows overlaid by this org's
 * own slice (§108 t-713).
 *
 * The org is the one whose scope this run of the sweep is in — the job runner
 * enters it (`lib/orchestration/maintenance/job-scope.ts`), so there is no
 * argument to pass and no way for a caller to ask for another org's windows.
 * Outside any tenant context, and under the system scope, there is no org and
 * the global windows stand alone.
 *
 * Precedence, per key: a key **absent** from the slice inherits the global
 * value; a key present — including an explicit `null`, which means keep this
 * class forever — replaces it. So an org lengthens or shortens exactly the
 * windows it names and follows the platform on the rest.
 *
 * **A failed org read skips the prunes rather than falling back to the global
 * windows.** The two degradations are not symmetrical: falling back would
 * prune an org's rows on a window that org had explicitly rejected, and
 * deletion is the direction that cannot be undone. `loadRetentionWindows`
 * degrades the same way for the same reason, one level up.
 *
 * **A slice applies at `multi` only, and the reason is confinement rather
 * than tidiness.** No prune carries an `orgId` — at `multi` the
 * `org_isolation` policies confine each one to the org whose scope it runs in
 * (§107), and at `single` nothing does: the extension issues no `set_config`
 * there at all. `forEachOrg` iterates every ACTIVE org whatever the mode and
 * the org API creates orgs in both, so a `single` install CAN hold more than
 * one — and one org's seven-day window would then delete every org's rows.
 * With one global window those N runs were identical and the exposure did not
 * exist. A slice set at `single` is still stored and still returned by the org
 * API, so switching the install to `multi` turns it on; until then the global
 * row governs, and the PATCH that stored it said so at the time.
 *
 * **The mode is necessary, not sufficient.** `TENANCY_MODE=multi` is an env
 * var, not evidence that `db:tenancy:enable` ever ran, and no prune carries an
 * `orgId` — so on a `multi` install whose policies were never enabled, or left
 * dormant by a `db:reset`, the shortest window any org sets still reaches
 * every org's rows. This gate closes the `single` case, which needed no
 * misconfiguration at all; the other is an operational one the playbook
 * already requires the operator to close for isolation of any kind, and
 * `.context/orchestration/retention.md` names what per-org windows change
 * about it. Revisit when §111 gives an org admin the window, which is when
 * that reliance becomes load-bearing for a cross-tenant delete.
 */
export async function loadEffectiveRetentionWindows(): Promise<{
  windows: RetentionWindows;
  /** The org these windows are for; `null` outside a tenant context. */
  orgId: string | null;
  /** Which windows this org set for itself, for the log line. */
  overrides: (keyof RetentionWindows)[];
}> {
  const globalWindows = await loadRetentionWindows();
  const orgId = getTenantContext()?.orgId ?? null;
  if (orgId === null) return { windows: globalWindows, orgId: null, overrides: [] };

  // Before the read, not after it: at `single` the answer is the global row
  // whatever the org stored, so reading would be an hourly query per org whose
  // only possible effect is to fail and skip prunes that were never in
  // question. The PATCH that stores a slice at `single` is where an operator
  // is told it will not apply yet.
  if (!isMultiTenant()) return { windows: globalWindows, orgId, overrides: [] };

  let slice: OrgRetentionSlice | null;
  try {
    slice = await loadOrgRetention(orgId);
  } catch (error) {
    logger.error('Could not read an org’s retention windows; skipping its prunes this sweep', {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { windows: NO_RETENTION_WINDOWS, orgId, overrides: [] };
  }
  if (!slice) return { windows: globalWindows, orgId, overrides: [] };

  const windows = { ...globalWindows };
  const overrides: (keyof RetentionWindows)[] = [];
  for (const key of RETENTION_WINDOW_KEYS) {
    const value = slice[key];
    if (value === undefined) continue;
    windows[key] = value;
    overrides.push(key);
  }
  return { windows, orgId, overrides };
}
