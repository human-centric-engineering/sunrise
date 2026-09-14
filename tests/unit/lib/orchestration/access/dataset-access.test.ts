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

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

import {
  datasetAccessBasis,
  adminCanViewDataset,
  datasetVisibilityWhere,
  logDatasetAccess,
} from '@/lib/orchestration/access/dataset-access';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import type { AuthenticatedSession } from '@/lib/auth/guards';

const ADMIN_ID = 'admin-1';
const OTHER_ID = 'admin-2';

/**
 * Enough of an `AuthenticatedSession` for these two faces.
 *
 * `unattributedReads` is the record the guard resolved from the policy before
 * the handler ran; `dataset` is the only key this module reads. Setting it
 * directly is the unit-level contract, matching `execution-access.test.ts` —
 * that the guard fills it from `canRead` is pinned in
 * `tests/unit/lib/auth/guards-authorization.test.ts`, that each helper reads
 * its OWN key in `tests/unit/lib/auth/orphan-reads.test.ts`, and that a fork's
 * policy reaches these routes end to end in the route tests.
 *
 * This used to register a policy and await the helper. t-687 made the helper
 * synchronous, which moved the policy out of this module's reach — so the three
 * cases that drove `canRead` from here (its `resource.kind`, and safe mode on a
 * throwing policy) moved to the two files named above rather than being
 * deleted.
 */
function sessionFor(userId: string, mayReadUnowned: boolean): AuthenticatedSession {
  return {
    user: { id: userId, role: 'ADMIN' },
    principal: { userId, role: 'ADMIN', credential: 'session' },
    unattributedReads: {
      conversation: mayReadUnowned,
      dataset: mayReadUnowned,
      execution: mayReadUnowned,
      experiment: mayReadUnowned,
    },
  } as unknown as AuthenticatedSession;
}

beforeEach(() => {
  vi.clearAllMocks();
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
  it('admits ownerless rows when the guard resolved a permitting policy', () => {
    expect(datasetVisibilityWhere(sessionFor(ADMIN_ID, true))).toEqual({
      OR: [{ userId: ADMIN_ID }, { userId: null }],
    });
  });

  it('narrows to the caller when the policy denied an unattributed read', () => {
    // The whole point of the seam: the same admin, a fork's narrower policy,
    // and the fragment changes without a line of route code changing.
    expect(datasetVisibilityWhere(sessionFor(ADMIN_ID, false))).toEqual({ userId: ADMIN_ID });
  });

  it('never admits another admin’s rows, on either branch', () => {
    // The direction no policy value may move. `'nobody owns this'` is a third
    // case, not a softer spelling of `'someone else owns this'` — widening the
    // owner clause instead of adding the third case is what #741 closed.
    for (const mayReadUnowned of [true, false]) {
      expect(
        JSON.stringify(datasetVisibilityWhere(sessionFor(ADMIN_ID, mayReadUnowned)))
      ).not.toContain(OTHER_ID);
    }
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
