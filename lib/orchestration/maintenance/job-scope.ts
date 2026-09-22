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
 * **Anything else is treated as per-org**, loudly — see {@link isSystemScope}
 * for why the test is a guard rather than `scope !== 'per-org'`.
 *
 * **At `single` a per-org job is behaviour-neutral**: the one org is the
 * install org, the run happens once, and the result — or the throw — is
 * returned exactly as the job produced it, so the tick's summary line does
 * not change shape. The fold below (numbers summed, arrays concatenated, an
 * `orgs` count) applies only when the run visited some number of orgs other
 * than one, which on a single-tenant install never happens.
 *
 * A per-org failure is contained per org: the remaining orgs still run, the
 * failure is logged with the org, and the outcome counts as "found work" so the
 * idle gate is never armed on an unknown state. With exactly one org the
 * failure propagates instead, so the registries' existing error handling —
 * and their existing tests — see what they always saw. A caller that reports a
 * status rather than a log line needs {@link noOrgSucceeded} to tell "some
 * orgs failed" from "the sweep is down", because the first case cannot reach
 * it as a throw.
 *
 * **The caller may supply the org list** ({@link RunScopedJobOptions.orgIds}).
 * The maintenance tick reads the active orgs once and hands the same list to
 * every per-org job, so a tick costs one org-list query rather than one per
 * due job; without it each run reads the list itself through
 * {@link forEachOrg}.
 */

import { logger } from '@/lib/logging';
import { forEachOrg, runAsOrg, runAsSystem } from '@/lib/tenancy/context';

/**
 * Where a job runs. `'per-org'` is the default for the fork seam and the only
 * choice for a platform job that touches tenant-owned rows; `{ system }` names
 * the reason a job needs the audited bypass.
 */
export type JobScope = 'per-org' | { system: string };

/**
 * Is this a well-formed system scope?
 *
 * The runner asks this rather than testing `scope !== 'per-org'`, because that
 * test is **fail-open**: any value that is not the exact literal — a typo like
 * `'system'`, a value that survived a JSON round-trip, anything a fork
 * registering from plain JavaScript passes — would have been handed to
 * `runAsSystem` and run the job under the RLS bypass with `undefined` as its
 * audit reason. That is the exact opposite of what the seam promises, and
 * `'system'` is a plausible typo precisely because it is the word the docs
 * use. Anything unrecognised is treated as per-org, which is the confining
 * answer.
 */
function isSystemScope(scope: unknown): scope is { system: string } {
  return (
    typeof scope === 'object' &&
    scope !== null &&
    'system' in scope &&
    typeof scope.system === 'string' &&
    scope.system.length > 0
  );
}

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
 * Did the job succeed for **no** org at all?
 *
 * True in two cases, and they are the same fact to whatever is watching: every
 * org it ran for failed, or it ran for no org (`orgs: 0` — the state the
 * runner refuses to let pass silently; see {@link runScopedJob}). A
 * mis-seeded database with no `ACTIVE` org would otherwise look exactly like a
 * quiet, healthy install.
 *
 * The runner contains a per-org failure so the remaining orgs still run, which
 * is right for the tick — one org's broken sweep must not stop the others. But
 * a caller that reports a status rather than a log line needs to tell "some
 * orgs failed" from "the sweep is down": with one org the throw propagates and
 * such a caller answers 500, and without this it would answer 200 the day a
 * second org was created, silencing a monitor exactly when the failure got
 * bigger. Only meaningful on a folded summary.
 */
export function noOrgSucceeded(result: unknown): result is PerOrgSummary {
  if (!isRecord(result) || typeof result.orgs !== 'number') return false;
  if (result.orgs === 0) return true;
  return Array.isArray(result.orgErrors) && result.orgErrors.length === result.orgs;
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
      } else if (!(key in summary)) {
        // First org to carry the key wins. Keyed on presence, not on
        // `undefined`: a leading `null` is a value an org reported, and
        // testing for undefined would let it be overwritten by the next org
        // while a non-null first value would not be — two different rules for
        // the same field.
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
  /**
   * The active orgs to iterate, when the caller has already read them.
   *
   * Without it each per-org job reads the org list itself, so one tick with
   * eight due jobs pays eight identical queries — the per-tick query count
   * #442 exists to hold down, on exactly the scale-to-zero Postgres it was
   * measured against. {@link listActiveOrgIds} is the read; the tick does it
   * once and passes the answer down. Ignored by a system-scoped job.
   */
  orgIds?: readonly string[];
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
  const { name, scope, run, foundWork, orgIds } = options;

  if (isSystemScope(scope)) {
    const result = await runAsSystem(scope.system, run);
    return { result, foundWork: foundWork(result) };
  }

  if (scope !== 'per-org') {
    // Unrecognised: run it scoped anyway, and say so. Refusing to run the job
    // would be the other defensible answer, but this one keeps a fork's typo
    // from silently stopping its maintenance as well as from silently
    // bypassing the policies.
    logger.error('maintenance task declared an unrecognised scope; running it per-org', {
      task: name,
      scope: JSON.stringify(scope),
    });
  }

  const outcomes: OrgOutcome<T>[] = [];
  const runForOrg = async (orgId: string): Promise<void> => {
    try {
      outcomes.push({ orgId, ok: true, result: await run() });
    } catch (error) {
      outcomes.push({ orgId, ok: false, error });
    }
  };

  if (orgIds) {
    // The caller already read the active orgs for this tick — see `orgIds`.
    for (const orgId of orgIds) {
      await runAsOrg(orgId, () => runForOrg(orgId), { source: 'job' });
    }
  } else {
    await forEachOrg(runForOrg);
  }

  if (outcomes.length === 1) {
    const [only] = outcomes;
    if (!only.ok) throw only.error;
    return { result: only.result, foundWork: foundWork(only.result) };
  }

  if (outcomes.length === 0) {
    // The install org always exists and a suspended one cannot be the only
    // org, so this is unreachable by design — which is exactly why it must
    // not pass silently. Reporting "nothing found" here would arm the idle
    // gate and stop all maintenance on the strength of a query that told us
    // nothing: "I could not look" read as "I found nothing"
    // (.context/architecture/checks.md).
    logger.warn('maintenance task found no active org to run for', { task: name });
    return { result: { orgs: 0 }, foundWork: true };
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
