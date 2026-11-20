/**
 * An app's own model pins and its check on a move (§136 t-1067).
 *
 * The registry is real; the fork's init is replaced here by one each test
 * controls (`appInit`), so the gate's rollback runs against a real throw. The
 * tenancy context is faked so each report can be seen running in its org.
 *
 * @see lib/orchestration/model-lifecycle/app-pins.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appInit = vi.hoisted(() => ({ run: (): void => {} }));
vi.mock('@/lib/app/model-pins', () => ({ initAppModelPins: () => appInit.run() }));
vi.mock('@/lib/tenancy/context', () => ({
  isMultiTenant: vi.fn(),
  listActiveOrgIds: vi.fn(),
  runAsOrg: vi.fn(),
  getTenantContext: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getTenantContext, isMultiTenant, listActiveOrgIds, runAsOrg } from '@/lib/tenancy/context';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import {
  APP_MODEL_MOVE_CHECK_TIMEOUT_MS,
  APP_MODEL_PIN_REPORT_TIMEOUT_MS,
  __resetAppModelPinsForTests,
  appModelPinsRegistered,
  checkAppModelMove,
  registerModelMoveCheck,
  registerModelPinReporter,
  reportAppModelPins,
  type AppModelMoveCheckRequest,
  type AppModelPinQuery,
} from '@/lib/orchestration/model-lifecycle/app-pins';

const MODEL = { id: 'm-old', name: 'GPT-4o', providerSlug: 'openai', modelId: 'gpt-4o' };
const REPLACEMENT = { id: 'm-new', name: 'GPT-4.1', providerSlug: 'openai', modelId: 'gpt-4.1' };

let scope: string | null = null;
let multi = true;

beforeEach(() => {
  vi.clearAllMocks();
  appInit.run = () => {};
  __resetAppModelPinsForTests();
  scope = null;
  multi = true;
  vi.mocked(isMultiTenant).mockImplementation(() => multi);
  vi.mocked(listActiveOrgIds).mockResolvedValue(['org-a', 'org-b']);
  vi.mocked(getTenantContext).mockImplementation(() =>
    scope ? ({ orgId: scope } as never) : (undefined as never)
  );
  vi.mocked(runAsOrg).mockImplementation(async (orgId: string, fn: () => Promise<unknown>) => {
    const outer = scope;
    scope = orgId;
    try {
      return await fn();
    } finally {
      scope = outer;
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A reporter answering per org from `byOrg`, recording the scope it ran in. */
function reportFrom(byOrg: Record<string, Array<{ label: string; where: string }>>) {
  const seen: Array<{ orgId: string; scope: string | null }> = [];
  registerModelPinReporter(({ orgId }: AppModelPinQuery) => {
    seen.push({ orgId, scope });
    return byOrg[orgId] ?? [];
  });
  return seen;
}

describe('with nothing registered', () => {
  it('reports nothing, enters no org, and allows every move', async () => {
    expect(appModelPinsRegistered()).toEqual({ reporter: false, check: false, failed: false });

    const report = await reportAppModelPins(MODEL);
    expect(report).toEqual({ pins: [], failed: false });
    expect(listActiveOrgIds).not.toHaveBeenCalled();
    expect(runAsOrg).not.toHaveBeenCalled();

    expect(await checkAppModelMove(MODEL, REPLACEMENT, report, 'move')).toEqual({ allowed: true });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('reportAppModelPins', () => {
  it('asks each active org inside its own scope, and stamps the org on its pins', async () => {
    const seen = reportFrom({
      'org-a': [{ label: 'Panel: Contracts', where: 'Panels › Contracts › Judge' }],
      'org-b': [
        { label: 'Panel: Claims', where: 'Panels › Claims › Judge' },
        // The app's own idea of the org is not trusted: Sunrise stamps it.
        { label: 'Panel: Leases', where: 'Panels › Leases', orgId: 'org-a' } as never,
      ],
    });

    const report = await reportAppModelPins(MODEL);

    expect(seen).toEqual([
      { orgId: 'org-a', scope: 'org-a' },
      { orgId: 'org-b', scope: 'org-b' },
    ]);
    expect(report).toEqual({
      failed: false,
      pins: [
        { label: 'Panel: Contracts', where: 'Panels › Contracts › Judge', orgId: 'org-a' },
        { label: 'Panel: Claims', where: 'Panels › Claims › Judge', orgId: 'org-b' },
        { label: 'Panel: Leases', where: 'Panels › Leases', orgId: 'org-b' },
      ],
    });
  });

  it('asks the entered org alone when not across orgs, and no org when none is entered', async () => {
    const seen = reportFrom({ 'org-b': [{ label: 'B', where: 'b' }] });

    scope = 'org-b';
    const own = await reportAppModelPins(MODEL, { acrossOrgs: false });
    expect(own.pins.map((p) => p.orgId)).toEqual(['org-b']);
    expect(listActiveOrgIds).not.toHaveBeenCalled();

    scope = null;
    expect(await reportAppModelPins(MODEL, { acrossOrgs: false })).toEqual({
      pins: [],
      failed: false,
    });
    expect(seen).toHaveLength(1);
  });

  it('asks the install org once at single, without entering a scope', async () => {
    multi = false;
    const seen = reportFrom({ [INSTALL_ORG_ID]: [{ label: 'X', where: 'x' }] });

    const report = await reportAppModelPins(MODEL);

    expect(seen).toEqual([{ orgId: INSTALL_ORG_ID, scope: null }]);
    expect(runAsOrg).not.toHaveBeenCalled();
    expect(report.pins).toEqual([{ label: 'X', where: 'x', orgId: INSTALL_ORG_ID }]);
  });

  it('passes the model, and marks the report failed for an org that throws or answers badly', async () => {
    const asked: AppModelPinQuery[] = [];
    vi.mocked(listActiveOrgIds).mockResolvedValue(['org-a', 'org-b', 'org-c']);
    registerModelPinReporter((query) => {
      asked.push(query);
      if (query.orgId === 'org-a') throw new Error('panel table missing');
      if (query.orgId === 'org-b') return [{ label: '', where: 'x' }];
      return [{ label: 'C', where: 'c' }];
    });

    const report = await reportAppModelPins(MODEL);

    expect(asked[0].model).toEqual(MODEL);
    expect(asked[0].signal).toBeInstanceOf(AbortSignal);
    // The orgs that answered are kept; the report says it is short.
    expect(report).toEqual({ failed: true, pins: [{ label: 'C', where: 'c', orgId: 'org-c' }] });
    expect(logger.error).toHaveBeenCalledWith('App model-pin reporter failed', expect.any(Error), {
      orgId: 'org-a',
      providerModelId: 'm-old',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'App model-pin reporter gave no usable answer',
      expect.objectContaining({ orgId: 'org-b' })
    );
  });

  it('gives up on a report that runs past its time, aborting its signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    registerModelPinReporter((query) => {
      signal = query.signal;
      return new Promise(() => {});
    });
    vi.mocked(listActiveOrgIds).mockResolvedValue(['org-a']);

    const pending = reportAppModelPins(MODEL);
    await vi.advanceTimersByTimeAsync(APP_MODEL_PIN_REPORT_TIMEOUT_MS);

    expect(await pending).toEqual({ pins: [], failed: true });
    expect(signal?.aborted).toBe(true);
  });
});

describe('checkAppModelMove', () => {
  const report = {
    pins: [{ label: 'Panel: Contracts', where: 'Panels', orgId: 'org-a' }],
    failed: false,
  };

  it('asks the check with both models and every pin, and follows its answer', async () => {
    const asked: AppModelMoveCheckRequest[] = [];
    registerModelMoveCheck((request) => {
      asked.push(request);
      return asked.length === 1
        ? { allow: true }
        : { allow: false, reason: 'GPT-4.1 failed the contract panel' };
    });

    expect(await checkAppModelMove(MODEL, REPLACEMENT, report, 'preview')).toEqual({
      allowed: true,
    });
    expect(await checkAppModelMove(MODEL, REPLACEMENT, report, 'move')).toEqual({
      allowed: false,
      reason: 'GPT-4.1 failed the contract panel',
    });
    expect(asked[0]).toMatchObject({
      model: MODEL,
      replacement: REPLACEMENT,
      pins: report.pins,
      phase: 'preview',
    });
    expect(asked[1].phase).toBe('move');
    expect(asked[0].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['throws', () => Promise.reject(new Error('eval service down'))],
    ['answers nothing', () => undefined],
    ['refuses without a reason', () => ({ allow: false, reason: '  ' })],
    ['answers a string', () => 'yes'],
  ])('refuses the move when the check %s (fails closed)', async (_how, answer) => {
    registerModelMoveCheck(answer as never);

    const verdict = await checkAppModelMove(MODEL, REPLACEMENT, report, 'move');

    expect(verdict.allowed).toBe(false);
    expect(verdict).toEqual({
      allowed: false,
      reason: 'The app’s check on this move failed. Nothing was moved; see the server log.',
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('refuses a check that runs past its time, aborting its signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    registerModelMoveCheck((request) => {
      signal = request.signal;
      return new Promise(() => {});
    });

    const pending = checkAppModelMove(MODEL, REPLACEMENT, report, 'move');
    await vi.advanceTimersByTimeAsync(APP_MODEL_MOVE_CHECK_TIMEOUT_MS);

    expect((await pending).allowed).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it('refuses, without asking, when the report it would be given is short', async () => {
    const check = vi.fn(() => ({ allow: true as const }));
    registerModelMoveCheck(check);

    const verdict = await checkAppModelMove(
      MODEL,
      REPLACEMENT,
      { ...report, failed: true },
      'move'
    );

    expect(verdict).toEqual({
      allowed: false,
      reason: expect.stringContaining('could not all be read'),
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('allows a short report when no check is registered: the reporter is informational', async () => {
    registerModelPinReporter(() => []);
    expect(await checkAppModelMove(MODEL, REPLACEMENT, { pins: [], failed: true }, 'move')).toEqual(
      {
        allowed: true,
      }
    );
  });
});

describe('an init that throws part-way', () => {
  it('rolls back what it registered, and refuses every move while the finder marks it', async () => {
    appInit.run = () => {
      registerModelPinReporter(() => [{ label: 'Kept?', where: 'x' }]);
      registerModelMoveCheck(() => ({ allow: true }));
      throw new Error('fork init bug');
    };

    expect(appModelPinsRegistered()).toEqual({ reporter: false, check: false, failed: true });
    expect(logger.error).toHaveBeenCalledWith(
      'model-pins: initAppModelPins threw — app model pins rolled back and disabled',
      expect.anything()
    );

    // Nothing it registered is asked; the report says it may be short.
    const report = await reportAppModelPins(MODEL);
    expect(report).toEqual({ pins: [], failed: true });
    expect(runAsOrg).not.toHaveBeenCalled();

    expect(await checkAppModelMove(MODEL, REPLACEMENT, report, 'move')).toEqual({
      allowed: false,
      reason: expect.stringContaining('failed to load'),
    });
  });

  it('runs the init once, however many reads', async () => {
    const init = vi.fn();
    appInit.run = init;
    appModelPinsRegistered();
    await reportAppModelPins(MODEL);
    await checkAppModelMove(MODEL, REPLACEMENT, { pins: [], failed: false }, 'move');
    expect(init).toHaveBeenCalledTimes(1);
  });
});
