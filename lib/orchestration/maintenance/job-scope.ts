/**
 * Which tenant scope a maintenance job runs in, and the runner that enters it
 * (§108 t-711).
 *
 * Before this module a job entered no tenant context at all. At
 * `TENANCY_MODE=single` that still resolved to the install org, so nothing
 * noticed; at `multi` the first touch of a tenant-owned table threw `No tenant
 * context` (contained by the registries, so nothing crashed and nothing read
 * wide — but nothing ran either), and a tick fired from an admin's browser
 * session inherited that admin's active org and silently ran every job for
 * that one org. RLS cannot see a cron tick; this is the piece that tells it
 * whose rows a job is acting on.
 *
 * Two scopes, and the default is the safe one:
 *
 *   • **`'per-org'`** — the job runs once per ACTIVE org through
 *     {@link forEachOrg}, each run inside that org's context (`source: 'job'`).
 *     Inside the scope the data layer stamps every create with the org and, at
 *     `multi`, the policies confine every read and write to it — so a `take:
 *     50` in the job body is a per-org cap for free. Every platform job that
 *     touches tenant-owned rows is per-org, including the sweeps that only
 *     *look* like global queue drains (the reaper writes lease events; recovery
 *     and the scheduler start the engine; the evaluation worker writes cases):
 *     under the system scope nothing is stamped, and each of those would land
 *     a `NULL`-org row that no org's policy ever shows again. §108 planning
 *     decision, 2026-09-21.
 *   • **`{ system: reason }`** — the job runs once under
 *     {@link runAsSystem}, the audited bypass, for work that is genuinely
 *     global: a prune of a system table, an aggregate that must see every
 *     org. The reason is what the audit log line carries, so make it a
 *     sentence an operator can act on.
 *
 * **At `single` a per-org job is behaviour-neutral**: the one org is the
 * install org, the run happens once, and the result is returned exactly as
 * the job produced it — the tick's summary line does not change shape. The
 * fold below (numbers summed, arrays concatenated, an `orgs` count) applies
 * only when more than one org was visited or an org failed, which is to say
 * only at `multi`.
 *
 * A per-org failure is contained per org: the remaining orgs still run, the
 * failure is logged with the org, and the outcome counts as "found work" so the
 * idle gate is never armed on an unknown state. With exactly one org the
 * failure propagates unchanged, so the registries' existing error handling —
 * and their existing tests — see what they always saw.
 */

import { logger } from '@/lib/logging';
import { forEachOrg, runAsSystem } from '@/lib/tenancy/context';

/**
 * Where a job runs. `'per-org'` is the default for the fork seam and the only
 * choice for a platform job that touches tenant-owned rows; `{ system }` names
 * the reason a job needs the audited bypass.
 */
export type JobScope = 'per-org' | { system: string };

/**
 * What the runner hands back: the job's own result (one org, or the system
 * scope) or the fold across orgs, plus the idle-gate bit.
 */
export interface ScopedJobOutcome<T> {
  result: T | PerOrgSummary;
  foundWork: boolean;
}

/** A per-org failure as it appears in a folded summary. */
export interface OrgJobError {
  orgId: string;
  error: string;
}

/**
 * The summary a per-org job produces when more than one org was visited (or
 * one failed): the numeric fields of every org's result summed, the array
 * fields concatenated, plus how many orgs ran and which failed. A job whose
 * result is a bare number folds to `{ orgs, total }`.
 */
export interface PerOrgSummary {
  orgs: number;
  orgErrors?: OrgJobError[];
  [key: string]: unknown;
}

type OrgOutcome<T> =
  { orgId: string; ok: true; result: T } | { orgId: string; ok: false; error: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fold N org results into one summary. Numbers add, arrays concatenate,
 * anything else keeps the first value seen — the results these jobs return
 * are counters and error lists, and a field that is neither is descriptive
 * (the same for every org) rather than additive.
 */
export function foldOrgResults<T>(outcomes: ReadonlyArray<OrgOutcome<T>>): PerOrgSummary {
  const summary: PerOrgSummary = { orgs: outcomes.length };
  const errors: OrgJobError[] = [];

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      errors.push({ orgId: outcome.orgId, error: errorText(outcome.error) });
      continue;
    }
    const { result } = outcome;
    if (typeof result === 'number') {
      summary.total = (typeof summary.total === 'number' ? summary.total : 0) + result;
      continue;
    }
    if (!isRecord(result)) continue;
    for (const [key, value] of Object.entries(result)) {
      // `orgs` / `orgErrors` are the fold's own keys; a job result that used
      // them would be overwritten silently, so they are skipped rather than
      // summed into the wrong meaning.
      if (key === 'orgs' || key === 'orgErrors') continue;
      const current = summary[key];
      if (typeof value === 'number') {
        summary[key] = (typeof current === 'number' ? current : 0) + value;
      } else if (Array.isArray(value)) {
        const items: unknown[] = value;
        const existing: unknown[] = Array.isArray(current) ? current : [];
        summary[key] = [...existing, ...items];
      } else if (current === undefined) {
        summary[key] = value;
      }
    }
  }

  if (errors.length > 0) summary.orgErrors = errors;
  return summary;
}

export interface RunScopedJobOptions<T> {
  /** The job's name, for the per-org failure log line. */
  name: string;
  scope: JobScope;
  run: () => Promise<T>;
  /**
   * Did one run find anything? Evaluated per org on the job's own result type,
   * then OR'd — a batch cap in one org is a reason to look again, whatever the
   * other orgs said.
   */
  foundWork: (result: T) => boolean;
}

/**
 * Run a job inside its scope and classify the outcome.
 *
 * Per-org: once per ACTIVE org, sequentially, each inside {@link forEachOrg}'s
 * scope. One org's throw is caught, logged with the org and folded in as an
 * `orgErrors` entry; the next org still runs. When exactly one org ran, the
 * result — or the throw — comes back as the job produced it, so a `single`
 * install sees no change.
 *
 * System: once under {@link runAsSystem} with the declared reason; a throw
 * propagates to the caller's existing containment.
 */
export async function runScopedJob<T>(
  options: RunScopedJobOptions<T>
): Promise<ScopedJobOutcome<T>> {
  const { name, scope, run, foundWork } = options;

  if (scope !== 'per-org') {
    const result = await runAsSystem(scope.system, run);
    return { result, foundWork: foundWork(result) };
  }

  const outcomes: OrgOutcome<T>[] = [];
  await forEachOrg(async (orgId) => {
    try {
      outcomes.push({ orgId, ok: true, result: await run() });
    } catch (error) {
      outcomes.push({ orgId, ok: false, error });
    }
  });

  if (outcomes.length === 1) {
    const [only] = outcomes;
    if (!only.ok) throw only.error;
    return { result: only.result, foundWork: foundWork(only.result) };
  }

  let anyFound = false;
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      // Logged here, per org, because the registries' own error line would
      // otherwise report one failure for a job that ran N times.
      logger.error('maintenance task failed for an org', {
        task: name,
        orgId: outcome.orgId,
        error: errorText(outcome.error),
      });
      anyFound = true;
    } else if (foundWork(outcome.result)) {
      anyFound = true;
    }
  }

  return { result: foldOrgResults(outcomes), foundWork: anyFound };
}
