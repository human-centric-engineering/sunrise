// @vitest-environment happy-dom

/**
 * Tests for `lib/orchestration/maintenance/job-scope.ts` (§108 t-711).
 *
 * The runner is what turns "a job ran" into "a job ran for THIS org", so the
 * assertions are about the context each run saw, not about the job. The real
 * `forEachOrg` / `runAsSystem` are used (with the `Org` read and the env
 * mocked) because the property under test — the ALS scope around each run —
 * lives in them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockFindMany = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: { org: { findMany: mockFindMany } } }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';
import {
  foldOrgResults,
  noOrgSucceeded,
  runScopedJob,
} from '@/lib/orchestration/maintenance/job-scope';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

function orgs(...ids: string[]): void {
  mockFindMany.mockResolvedValue(ids.map((id) => ({ id })));
}

/** A job body that records the tenant context it ran in and returns `result(orgId)`. */
function recordingJob<T>(result: (orgId: string | null) => T) {
  const seen: Array<{ orgId: string | null; source: string } | null> = [];
  const run = vi.fn(async () => {
    const ctx = getTenantContext();
    seen.push(ctx ? { orgId: ctx.orgId, source: ctx.source } : null);
    return result(ctx?.orgId ?? null);
  });
  return { run, seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  orgs(INSTALL_ORG_ID);
});

describe('runScopedJob — per-org at single', () => {
  it('runs once, inside the install org as a job, and returns the result untouched', async () => {
    const { run, seen } = recordingJob(() => ({ pruned: 3, errors: ['x'] }));

    const outcome = await runScopedJob({
      name: 'demo',
      scope: 'per-org',
      run,
      foundWork: (r) => r.pruned > 0,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ orgId: INSTALL_ORG_ID, source: 'job' }]);
    // Byte-identical: no fold, no `orgs` key — the tick's log line at single
    // does not change shape.
    expect(outcome).toEqual({ result: { pruned: 3, errors: ['x'] }, foundWork: true });
  });

  it('lets the one org’s failure propagate, so the registries’ own containment sees it', async () => {
    const run = vi.fn().mockRejectedValue(new Error('DB down'));

    await expect(
      runScopedJob({ name: 'demo', scope: 'per-org', run, foundWork: () => false })
    ).rejects.toThrow('DB down');
    // Not logged here: with one org the caller's existing error line is the record.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not inherit an ambient org — the run happens inside the iterated org, not the caller’s', async () => {
    const { run, seen } = recordingJob(() => 0);

    await runAsOrg(ORG_B, () =>
      runScopedJob({ name: 'demo', scope: 'per-org', run, foundWork: () => false })
    );

    expect(seen).toEqual([{ orgId: INSTALL_ORG_ID, source: 'job' }]);
  });
});

describe('runScopedJob — per-org at multi', () => {
  beforeEach(() => {
    mockEnv.TENANCY_MODE = 'multi';
    orgs(ORG_A, ORG_B);
  });

  it('runs once per active org, each inside its own scope, and folds the results', async () => {
    const { run, seen } = recordingJob((orgId) => ({
      recovered: orgId === ORG_A ? 2 : 5,
      errors: orgId === ORG_A ? [] : [{ executionId: 'e1', error: 'boom' }],
    }));

    const outcome = await runScopedJob({
      name: 'demo',
      scope: 'per-org',
      run,
      foundWork: (r) => r.recovered > 0,
    });

    expect(seen).toEqual([
      { orgId: ORG_A, source: 'job' },
      { orgId: ORG_B, source: 'job' },
    ]);
    expect(outcome).toEqual({
      result: { orgs: 2, recovered: 7, errors: [{ executionId: 'e1', error: 'boom' }] },
      foundWork: true,
    });
  });

  it('ORs foundWork across orgs — one org’s batch cap is a reason to look again', async () => {
    const { run } = recordingJob((orgId) => (orgId === ORG_B ? 25 : 0));

    const outcome = await runScopedJob({
      name: 'demo',
      scope: 'per-org',
      run,
      foundWork: (r) => r > 0,
    });

    expect(outcome).toEqual({ result: { orgs: 2, total: 25 }, foundWork: true });
  });

  it('is false only when every org found nothing', async () => {
    const { run } = recordingJob(() => 0);

    const outcome = await runScopedJob({
      name: 'demo',
      scope: 'per-org',
      run,
      foundWork: (r) => r > 0,
    });

    expect(outcome.foundWork).toBe(false);
  });

  it('contains one org’s failure, still runs the next org, logs the org, and counts it as work', async () => {
    const run = vi.fn(async () => {
      if (getTenantContext()?.orgId === ORG_A) throw new Error('A is broken');
      return { pruned: 1 };
    });

    const outcome = await runScopedJob({
      name: 'demo',
      scope: 'per-org',
      run,
      foundWork: () => false,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      result: { orgs: 2, pruned: 1, orgErrors: [{ orgId: ORG_A, error: 'A is broken' }] },
      // The predicate said "nothing" for B; the unknown outcome in A wins.
      foundWork: true,
    });
    expect(logger.error).toHaveBeenCalledWith(
      'maintenance task failed for an org',
      expect.objectContaining({ task: 'demo', orgId: ORG_A, error: 'A is broken' })
    );
  });

  it('skips suspended orgs, because forEachOrg only visits ACTIVE ones', async () => {
    const { run } = recordingJob(() => 0);

    await runScopedJob({ name: 'demo', scope: 'per-org', run, foundWork: () => false });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE' } })
    );
  });

  it('warns and reports work when there is no active org, rather than arming the gate', async () => {
    // Unreachable by design (the install org always exists and cannot be
    // suspended), which is why it must not pass silently: reporting "nothing
    // found" here would arm the idle gate and stop all maintenance on the
    // strength of a query that told us nothing.
    orgs();
    const { run } = recordingJob(() => 0);

    const outcome = await runScopedJob({
      name: 'demo',
      scope: 'per-org',
      run,
      foundWork: () => false,
    });

    expect(run).not.toHaveBeenCalled();
    expect(outcome).toEqual({ result: { orgs: 0 }, foundWork: true });
    expect(logger.warn).toHaveBeenCalledWith('maintenance task found no active org to run for', {
      task: 'demo',
    });
  });

  it('leaves no context on the caller afterwards', async () => {
    const { run } = recordingJob(() => 0);

    await runScopedJob({ name: 'demo', scope: 'per-org', run, foundWork: () => false });

    expect(getTenantContext()).toBeNull();
  });
});

describe('runScopedJob — an unrecognised scope fails CLOSED', () => {
  // `scope !== 'per-org'` would have handed any of these to `runAsSystem` and
  // run the job under the RLS bypass with `undefined` as its audit reason —
  // the opposite of what the seam promises, and `'system'` is a plausible typo
  // precisely because it is the word the docs use.
  it.each([
    ['the string "system"', 'system'],
    ['an object with no reason', { system: undefined }],
    ['an object with an empty reason', { system: '' }],
    ['null', null],
  ])('runs per-org and logs an error for %s', async (_label, badScope) => {
    mockEnv.TENANCY_MODE = 'multi';
    orgs(ORG_A, ORG_B);
    const { run, seen } = recordingJob(() => 0);

    const outcome = await runScopedJob({
      name: 'demo',
      // The type forbids these; the guard is for a fork registering from
      // plain JavaScript, or a value that survived a JSON round-trip.
      scope: badScope as never,
      run,
      foundWork: () => false,
    });

    expect(seen).toEqual([
      { orgId: ORG_A, source: 'job' },
      { orgId: ORG_B, source: 'job' },
    ]);
    expect(outcome.result).toEqual({ orgs: 2, total: 0 });
    expect(logger.info).not.toHaveBeenCalledWith('Entering system tenant scope', expect.anything());
    expect(logger.error).toHaveBeenCalledWith(
      'maintenance task declared an unrecognised scope; running it per-org',
      expect.objectContaining({ task: 'demo' })
    );
  });
});

describe('runScopedJob — a caller-supplied org list', () => {
  it('iterates the given orgs and reads no org list of its own', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    orgs(ORG_A, ORG_B);
    const { run, seen } = recordingJob(() => 0);

    await runScopedJob({
      name: 'demo',
      scope: 'per-org',
      run,
      foundWork: () => false,
      orgIds: [ORG_A, ORG_B],
    });

    expect(seen).toEqual([
      { orgId: ORG_A, source: 'job' },
      { orgId: ORG_B, source: 'job' },
    ]);
    // The point of the parameter: one org-list query per tick, not one per job.
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('still enters each org’s scope, so a failure is contained per org', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    const run = vi.fn(async () => {
      if (getTenantContext()?.orgId === ORG_A) throw new Error('A down');
      return 1;
    });

    const outcome = await runScopedJob({
      name: 'demo',
      scope: 'per-org',
      run,
      foundWork: () => false,
      orgIds: [ORG_A, ORG_B],
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome.result).toEqual({
      orgs: 2,
      total: 1,
      orgErrors: [{ orgId: ORG_A, error: 'A down' }],
    });
  });
});

describe('runScopedJob — system', () => {
  it('runs once under the audited system scope with the declared reason, in either mode', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    orgs(ORG_A, ORG_B);
    const { run, seen } = recordingJob(() => ({ auditLogsDeleted: 4 }));

    const outcome = await runScopedJob({
      name: 'auditLogRetention',
      scope: { system: 'prune the audit tables' },
      run,
      foundWork: (r) => r.auditLogsDeleted > 0,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ orgId: null, source: 'system' }]);
    expect(outcome).toEqual({ result: { auditLogsDeleted: 4 }, foundWork: true });
    // The audit line: an unexplained bypass is what this log exists to surface.
    expect(logger.info).toHaveBeenCalledWith('Entering system tenant scope', {
      reason: 'prune the audit tables',
    });
    // No org iteration for a system job.
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('propagates a failure unchanged', async () => {
    const run = vi.fn().mockRejectedValue(new Error('nope'));

    await expect(
      runScopedJob({ name: 'x', scope: { system: 'r' }, run, foundWork: () => false })
    ).rejects.toThrow('nope');
  });
});

describe('foldOrgResults', () => {
  it('sums numbers, concatenates arrays, keeps the first descriptive value', () => {
    const folded = foldOrgResults([
      { orgId: ORG_A, ok: true, result: { n: 1, list: ['a'], mode: 'x' } },
      { orgId: ORG_B, ok: true, result: { n: 2, list: ['b'], mode: 'y' } },
    ]);

    expect(folded).toEqual({ orgs: 2, n: 3, list: ['a', 'b'], mode: 'x' });
  });

  it('folds a bare-number result into total', () => {
    expect(
      foldOrgResults([
        { orgId: ORG_A, ok: true, result: 3 },
        { orgId: ORG_B, ok: true, result: 4 },
      ])
    ).toEqual({ orgs: 2, total: 7 });
  });

  it('records each failed org and still sums the rest', () => {
    expect(
      foldOrgResults([
        { orgId: ORG_A, ok: false, error: new Error('x') },
        { orgId: ORG_B, ok: true, result: { n: 2 } },
      ])
    ).toEqual({ orgs: 2, n: 2, orgErrors: [{ orgId: ORG_A, error: 'x' }] });
  });

  it('keeps the first org’s value for a descriptive key even when it is null', () => {
    // Keyed on presence, not on `!== undefined`: a leading `null` is a value
    // org A reported, and the next org must not silently replace it while a
    // non-null first value would have been kept.
    expect(
      foldOrgResults([
        { orgId: ORG_A, ok: true, result: { lastRunAt: null, n: 1 } },
        { orgId: ORG_B, ok: true, result: { lastRunAt: 'later', n: 1 } },
      ])
    ).toEqual({ orgs: 2, lastRunAt: null, n: 2 });
  });

  it('never lets a job result overwrite the fold’s own keys', () => {
    expect(
      foldOrgResults([{ orgId: ORG_A, ok: true, result: { orgs: 99, orgErrors: ['bogus'], n: 1 } }])
    ).toEqual({ orgs: 1, n: 1 });
  });

  it('ignores a non-object, non-number result (an app job returning undefined)', () => {
    expect(
      foldOrgResults([
        { orgId: ORG_A, ok: true, result: undefined },
        { orgId: ORG_B, ok: true, result: undefined },
      ])
    ).toEqual({ orgs: 2 });
  });
});

describe('noOrgSucceeded', () => {
  it('is true when every org that ran failed', () => {
    expect(
      noOrgSucceeded({
        orgs: 2,
        orgErrors: [
          { orgId: ORG_A, error: 'x' },
          { orgId: ORG_B, error: 'y' },
        ],
      })
    ).toBe(true);
  });

  it('is true when the sweep ran for no org at all', () => {
    // A mis-seeded database with no ACTIVE org would otherwise be
    // indistinguishable from a quiet, healthy install to whatever is watching.
    expect(noOrgSucceeded({ orgs: 0 })).toBe(true);
  });

  it('is false when at least one org succeeded', () => {
    expect(noOrgSucceeded({ orgs: 2, orgErrors: [{ orgId: ORG_A, error: 'x' }] })).toBe(false);
    expect(noOrgSucceeded({ orgs: 2 })).toBe(false);
  });

  it('is false for a single org’s own result, which is not a fold', () => {
    // With one org a failure propagates as a throw instead, so this predicate
    // never sees it.
    expect(noOrgSucceeded({ processed: 0, succeeded: 0, failed: 0, errors: [] })).toBe(false);
  });
});
