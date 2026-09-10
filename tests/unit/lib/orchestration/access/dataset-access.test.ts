/**
 * Unit Test: evaluation-dataset access authorization
 *
 * @see lib/orchestration/access/dataset-access.ts
 *
 * Sits beside `execution-access.test.ts` and `conversation-access.test.ts`,
 * which cover the same shape for rows that are born ownerless. What is pinned
 * here that they do not have: the widening is the POLICY's answer, not a
 * hard-coded rule, so both branches are exercised.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

import {
  datasetAccessBasis,
  adminCanViewDataset,
  datasetVisibilityWhere,
  logDatasetAccess,
  DATASET_RESOURCE_KIND,
} from '@/lib/orchestration/access/dataset-access';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import type { AuthenticatedSession } from '@/lib/auth/guards';

const ADMIN_ID = 'admin-1';
const OTHER_ID = 'admin-2';

/** Enough of an AuthenticatedSession for these two faces. */
function sessionFor(userId: string, role: string): AuthenticatedSession {
  return {
    user: { id: userId, role },
    principal: { userId, role, credential: 'session' },
  } as unknown as AuthenticatedSession;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

describe('datasetAccessBasis', () => {
  it("names the caller's own row 'owner'", () => {
    expect(datasetAccessBasis({ userId: ADMIN_ID }, ADMIN_ID)).toBe('owner');
  });

  it("names a row nobody owns 'orphan', not 'system'", () => {
    // The neighbours use 'system' for rows that were NEVER personal. A null
    // here means an erasure detached a real owner, which is a different fact
    // and deserves different audit weight.
    expect(datasetAccessBasis({ userId: null }, ADMIN_ID)).toBe('orphan');
  });

  it("refuses another admin's row", () => {
    expect(datasetAccessBasis({ userId: OTHER_ID }, ADMIN_ID)).toBeNull();
  });

  it('refuses a missing row', () => {
    expect(datasetAccessBasis(null, ADMIN_ID)).toBeNull();
    expect(datasetAccessBasis(undefined, ADMIN_ID)).toBeNull();
  });
});

describe('adminCanViewDataset', () => {
  it('is the yes/no form of the same rule', () => {
    expect(adminCanViewDataset({ userId: ADMIN_ID }, ADMIN_ID)).toBe(true);
    expect(adminCanViewDataset({ userId: null }, ADMIN_ID)).toBe(true);
    expect(adminCanViewDataset({ userId: OTHER_ID }, ADMIN_ID)).toBe(false);
    expect(adminCanViewDataset(null, ADMIN_ID)).toBe(false);
  });
});

describe('datasetVisibilityWhere', () => {
  it('admits ownerless rows for a platform admin under the default policy', async () => {
    await expect(datasetVisibilityWhere(sessionFor(ADMIN_ID, 'ADMIN'))).resolves.toEqual({
      OR: [{ userId: ADMIN_ID }, { userId: null }],
    });
  });

  it('narrows to the caller when the policy denies an unattributed read', async () => {
    // The whole point of the seam: the same admin, a fork's narrower policy,
    // and the fragment changes without a line of route code changing.
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target, scope) =>
        target.kind === 'unattributed'
          ? Promise.resolve(false)
          : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
    });

    await expect(datasetVisibilityWhere(sessionFor(ADMIN_ID, 'ADMIN'))).resolves.toEqual({
      userId: ADMIN_ID,
    });
  });

  it('asks the policy about this model by name', async () => {
    const canRead = vi.fn().mockResolvedValue(true);
    registerAuthorizationPolicy({ ...DEFAULT_AUTHORIZATION_POLICY, canRead });

    await datasetVisibilityWhere(sessionFor(ADMIN_ID, 'ADMIN'));

    // A generic label would make a fork unable to answer differently per model.
    expect(canRead).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ADMIN_ID }),
      { kind: 'unattributed', resource: { kind: DATASET_RESOURCE_KIND } },
      expect.anything()
    );
  });

  it('narrows rather than widens when the policy throws', async () => {
    // Safe mode denies the unattributed arm, so the failure direction is
    // "orphans stay hidden", never "orphans become public".
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: () => {
        throw new Error('policy exploded');
      },
    });

    await expect(datasetVisibilityWhere(sessionFor(ADMIN_ID, 'ADMIN'))).resolves.toEqual({
      userId: ADMIN_ID,
    });
  });
});

describe('logDatasetAccess', () => {
  it('does not log routine self-access', () => {
    logDatasetAccess({
      adminUserId: ADMIN_ID,
      datasetId: 'ds-1',
      datasetName: 'fixtures',
      basis: 'owner',
      action: 'dataset.view',
    });

    expect(vi.mocked(logAdminAction)).not.toHaveBeenCalled();
  });

  it('logs access to a row that is not the caller’s own, carrying the basis', () => {
    logDatasetAccess({
      adminUserId: ADMIN_ID,
      datasetId: 'ds-1',
      datasetName: 'fixtures',
      basis: 'orphan',
      action: 'dataset.delete',
      extra: { fields: ['name'] },
      clientIp: '127.0.0.1',
    });

    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'dataset.delete',
      entityType: 'dataset',
      entityId: 'ds-1',
      entityName: 'fixtures',
      metadata: { accessBasis: 'orphan', fields: ['name'] },
      clientIp: '127.0.0.1',
    });
  });
});
