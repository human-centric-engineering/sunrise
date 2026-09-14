/**
 * Unit Test: experiment access authorization
 *
 * @see lib/orchestration/access/experiment-access.ts
 *
 * The module is new in t-687 but the rule is not: it moved here from
 * `lib/orchestration/experiments/visible-scope.ts`, which had **no unit test
 * file of its own** — only `orphan-reads.test.ts` pinning its resource-kind
 * constant, and the route tests reaching it through nine handlers. So most of
 * what is below is coverage the rule never had rather than a port of coverage
 * it did.
 *
 * Sits beside `dataset-access.test.ts` (the other `SetNull` model, same
 * `'orphan'` basis) and `execution-access.test.ts` / `conversation-access.test.ts`
 * (born ownerless, `'system'` basis). What this file has that they do not is the
 * audit rule: `logExperimentAccess` is the only one of the four whose call sites
 * choose whether routine self-access is recorded, so both answers are pinned.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

import {
  experimentAccessBasis,
  experimentVisibilityWhere,
  logExperimentAccess,
} from '@/lib/orchestration/access/experiment-access';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import type { AuthenticatedSession } from '@/lib/auth/guards';

const ADMIN_ID = 'admin-1';
const OTHER_ID = 'admin-2';

/**
 * Enough of an `AuthenticatedSession` for the face under test.
 *
 * `unattributedReads` is the record the guard resolved from the policy before
 * the handler ran; `experiment` is the only key this module reads. That the
 * guard fills it from `canRead` is pinned in `guards-authorization.test.ts`,
 * that each helper reads its OWN key in `orphan-reads.test.ts`, and that a
 * fork's policy reaches these routes end to end in the route tests.
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

describe('experimentAccessBasis', () => {
  it("names the caller's own row 'owner'", () => {
    expect(experimentAccessBasis({ createdBy: ADMIN_ID }, ADMIN_ID)).toBe('owner');
  });

  it("names a row nobody owns 'orphan', not 'system'", () => {
    // `createdBy` is `SetNull`, so a null here can only mean an erasure detached
    // a real owner. The two born-ownerless models say `'system'` for the same
    // column state and the names must not be interchanged: `Cascade` versus
    // `SetNull` makes the two facts disjoint.
    expect(experimentAccessBasis({ createdBy: null }, ADMIN_ID)).toBe('orphan');
  });

  it("refuses another admin's row", () => {
    expect(experimentAccessBasis({ createdBy: OTHER_ID }, ADMIN_ID)).toBeNull();
  });

  it('refuses a missing row', () => {
    expect(experimentAccessBasis(null, ADMIN_ID)).toBeNull();
    expect(experimentAccessBasis(undefined, ADMIN_ID)).toBeNull();
  });
});

describe('experimentVisibilityWhere', () => {
  it('admits ownerless rows when the guard resolved a permitting policy', () => {
    expect(experimentVisibilityWhere(sessionFor(ADMIN_ID, true))).toEqual({
      OR: [{ createdBy: ADMIN_ID }, { createdBy: null }],
    });
  });

  it('narrows to the caller when the policy denied an unattributed read', () => {
    // The capability this whole sweep exists to deliver, and the branch that
    // was unreachable before t-687 on every route in this family: the fragment
    // changes without a line of route code changing.
    expect(experimentVisibilityWhere(sessionFor(ADMIN_ID, false))).toEqual({
      createdBy: ADMIN_ID,
    });
  });

  it("never admits another admin's rows, on either branch", () => {
    // The direction no policy value may move. "Nobody owns this" is a third
    // case, not a softer spelling of "someone else owns this" — widening the
    // owner clause instead of adding the third case is what #741 closed on this
    // very model.
    for (const mayReadUnowned of [true, false]) {
      const where = experimentVisibilityWhere(sessionFor(ADMIN_ID, mayReadUnowned));
      expect(JSON.stringify(where)).not.toContain(OTHER_ID);
    }
  });

  it('never degrades to a clause that matches everything', () => {
    // An empty object, or an `OR` with no arms, would hand the whole install to
    // exactly the fork that asked to be narrowed. Both branches keep a usable
    // owner arm.
    for (const mayReadUnowned of [true, false]) {
      const where = experimentVisibilityWhere(sessionFor(ADMIN_ID, mayReadUnowned));
      expect(Object.keys(where).length).toBeGreaterThan(0);
      expect(JSON.stringify(where)).toContain(ADMIN_ID);
    }
  });
});

describe('logExperimentAccess', () => {
  it("does not record routine self-access under 'non-owner-only'", () => {
    logExperimentAccess({
      adminUserId: ADMIN_ID,
      experimentId: 'exp-1',
      experimentName: 'Prompt A/B',
      basis: 'owner',
      action: 'experiment.view',
      record: 'non-owner-only',
    });

    expect(vi.mocked(logAdminAction)).not.toHaveBeenCalled();
  });

  it('records a read of a row nobody owns, carrying the basis', () => {
    logExperimentAccess({
      adminUserId: ADMIN_ID,
      experimentId: 'exp-1',
      experimentName: 'Prompt A/B',
      basis: 'orphan',
      action: 'experiment.view',
      record: 'non-owner-only',
      clientIp: '127.0.0.1',
    });

    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      action: 'experiment.view',
      entityType: 'experiment',
      entityId: 'exp-1',
      entityName: 'Prompt A/B',
      metadata: { accessBasis: 'orphan' },
      clientIp: '127.0.0.1',
    });
  });

  it("records the owner's own write under 'always'", () => {
    // The rule that differs from `logDatasetAccess`, and the reason this field
    // has no default. Every mutation of an experiment wrote an audit row before
    // this helper existed — narrowing that to non-owners to match datasets
    // exactly would delete rows an operator can read today.
    logExperimentAccess({
      adminUserId: ADMIN_ID,
      experimentId: 'exp-1',
      experimentName: 'Prompt A/B',
      basis: 'owner',
      action: 'experiment.update',
      record: 'always',
      extra: { changedKeys: ['name'] },
    });

    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'experiment.update',
        metadata: { changedKeys: ['name'], accessBasis: 'owner' },
        clientIp: null,
      })
    );
  });

  it('puts the basis beyond the reach of a caller-supplied key', () => {
    // `extra` is spread first so a route passing `accessBasis` cannot relabel
    // its own access. Same rule as the `where` clauses: the security key goes
    // last, so nothing can spread over it.
    logExperimentAccess({
      adminUserId: ADMIN_ID,
      experimentId: 'exp-1',
      experimentName: null,
      basis: 'orphan',
      action: 'experiment.delete',
      record: 'always',
      extra: { accessBasis: 'owner' },
    });

    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { accessBasis: 'orphan' } })
    );
  });
});
