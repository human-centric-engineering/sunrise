/**
 * Tests: resolving the retention windows one org actually prunes on (§108 t-713)
 *
 * The sweep's own tests (`retention.test.ts`) prove the windows reach the
 * prunes — a shorter one deletes sooner, a `null` deletes nothing. What is
 * here is what the resolver decides *before* any prune runs, and is invisible
 * from the other side: which scopes read an org at all, and what the answer
 * carries back for the log line.
 *
 * @see lib/orchestration/retention-windows.ts
 * @see lib/tenancy/org-settings.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockSettingsFindUnique = vi.hoisted(() => vi.fn());
const mockOrgFindUnique = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiOrchestrationSettings: { findUnique: mockSettingsFindUnique },
    org: { findUnique: mockOrgFindUnique },
  },
}));

import {
  loadEffectiveRetentionWindows,
  loadRetentionWindows,
  readRetentionWindows,
  RETENTION_WINDOW_KEYS,
} from '@/lib/orchestration/retention-windows';
import { runAsOrg, runAsSystem } from '@/lib/tenancy/context';

const ORG_A = 'cmorg00000000000000000orga';

const GLOBAL = {
  webhookRetentionDays: 30,
  webhookDlqRetentionDays: null,
  costLogRetentionDays: 365,
  executionRetentionDays: 90,
  evaluationRetentionDays: 90,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  mockSettingsFindUnique.mockResolvedValue(GLOBAL);
  mockOrgFindUnique.mockResolvedValue({ settings: null });
});

describe('readRetentionWindows', () => {
  it('throws, so a write guard cannot read "could not look" as "nothing to check"', async () => {
    mockSettingsFindUnique.mockRejectedValue(new Error('db unavailable'));

    await expect(readRetentionWindows()).rejects.toThrow('db unavailable');
  });

  it('answers all-null for an install with no settings row yet', async () => {
    mockSettingsFindUnique.mockResolvedValue(null);

    await expect(readRetentionWindows()).resolves.toEqual({
      webhookRetentionDays: null,
      webhookDlqRetentionDays: null,
      costLogRetentionDays: null,
      executionRetentionDays: null,
      evaluationRetentionDays: null,
    });
  });
});

describe('loadRetentionWindows', () => {
  it('reads the five windows the tenant sweep uses, and not the audit one', async () => {
    await loadRetentionWindows();

    const select = mockSettingsFindUnique.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual([...RETENTION_WINDOW_KEYS].sort());
    expect(select).not.toHaveProperty('auditLogRetentionDays');
  });

  it('degrades to "nothing is pruned" when the settings row cannot be read', async () => {
    mockSettingsFindUnique.mockRejectedValue(new Error('db unavailable'));

    await expect(loadRetentionWindows()).resolves.toEqual({
      webhookRetentionDays: null,
      webhookDlqRetentionDays: null,
      costLogRetentionDays: null,
      executionRetentionDays: null,
      evaluationRetentionDays: null,
    });
  });
});

describe('loadEffectiveRetentionWindows', () => {
  it('overlays the org’s slice per key and reports which keys it took', async () => {
    mockOrgFindUnique.mockResolvedValue({
      settings: { retention: { executionRetentionDays: 365, webhookRetentionDays: null } },
    });

    const effective = await runAsOrg(ORG_A, () => loadEffectiveRetentionWindows());

    expect(effective.windows).toEqual({
      ...GLOBAL,
      executionRetentionDays: 365,
      webhookRetentionDays: null,
    });
    expect(effective.orgId).toBe(ORG_A);
    expect(effective.overrides.sort()).toEqual(['executionRetentionDays', 'webhookRetentionDays']);
  });

  it('reports no overrides for an org that has set nothing', async () => {
    const effective = await runAsOrg(ORG_A, () => loadEffectiveRetentionWindows());

    expect(effective.windows).toEqual(GLOBAL);
    expect(effective.overrides).toEqual([]);
  });

  it('reads no org outside a tenant context', async () => {
    const effective = await loadEffectiveRetentionWindows();

    expect(effective).toEqual({ windows: GLOBAL, orgId: null, overrides: [] });
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
  });

  it('reads no org under the system scope, where there is no org to read', async () => {
    // A system-scoped caller is under the RLS bypass, so "which org's windows"
    // has no answer — and an arbitrary org's would be the wrong one.
    const effective = await runAsSystem('test: a system-scoped caller', () =>
      loadEffectiveRetentionWindows()
    );

    expect(effective.orgId).toBeNull();
    expect(effective.windows).toEqual(GLOBAL);
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
  });

  it('ignores a slice at TENANCY_MODE=single, without even reading it', async () => {
    // No prune carries an orgId, and at `single` there are no policies — so
    // with two orgs on a single-mode install (which the org API allows), this
    // org's 7 days would reach the other org's rows.
    //
    // Not reading is the second half: a read that can only be discarded is an
    // hourly query per org whose one possible effect is to fail and skip
    // prunes that were never in question.
    mockEnv.TENANCY_MODE = 'single';
    mockOrgFindUnique.mockResolvedValue({
      settings: { retention: { executionRetentionDays: 7 } },
    });

    const effective = await runAsOrg(ORG_A, () => loadEffectiveRetentionWindows());

    expect(effective.windows).toEqual(GLOBAL);
    expect(effective.overrides).toEqual([]);
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
  });

  it('cannot have a single-mode install’s prunes skipped by an org read', async () => {
    // The failure the hoist removes: at `single` this read is never made, so
    // it cannot fail, so the prunes cannot be skipped by it.
    mockEnv.TENANCY_MODE = 'single';
    mockOrgFindUnique.mockRejectedValue(new Error('db unavailable'));

    const effective = await runAsOrg(ORG_A, () => loadEffectiveRetentionWindows());

    expect(effective.windows).toEqual(GLOBAL);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('prunes nothing, rather than falling back to the global row, when the org read fails', async () => {
    mockOrgFindUnique.mockRejectedValue(new Error('db unavailable'));

    const effective = await runAsOrg(ORG_A, () => loadEffectiveRetentionWindows());

    expect(Object.values(effective.windows).every((value) => value === null)).toBe(true);
    expect(effective.orgId).toBe(ORG_A);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('retention windows'),
      expect.objectContaining({ orgId: ORG_A, error: 'db unavailable' })
    );
  });
});
