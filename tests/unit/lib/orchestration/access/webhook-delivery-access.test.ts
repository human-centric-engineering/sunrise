/**
 * Unit Test: webhook delivery access authorization
 *
 * @see lib/orchestration/access/webhook-delivery-access.ts
 *
 * Replaces `delivery-scope.test.ts`, which pinned a hard-coded "every admin
 * sees every orphan" rule. The orphan arm is now the policy's answer
 * (`session.unattributedReads.webhookDelivery`), so every case below runs with
 * the answer both ways and the control is the other way round.
 */

import { describe, it, expect } from 'vitest';

import {
  webhookDeliveryAccessBasis,
  webhookDeliveryVisibilityWhere,
} from '@/lib/orchestration/access/webhook-delivery-access';
import type { AuthenticatedSession } from '@/lib/auth/guards';

const ADMIN_ID = 'admin-1';
const OTHER_ID = 'admin-2';

/**
 * `webhookDelivery` is the only key this module reads, so the other kinds are
 * set to the OPPOSITE value: a helper reading a neighbour's key goes red.
 */
function sessionFor(mayReadOrphans: boolean): AuthenticatedSession {
  return {
    user: { id: ADMIN_ID, role: 'ADMIN' },
    principal: { userId: ADMIN_ID, role: 'ADMIN', credential: 'session' },
    unattributedReads: {
      conversation: !mayReadOrphans,
      dataset: !mayReadOrphans,
      execution: !mayReadOrphans,
      experiment: !mayReadOrphans,
      webhookDelivery: mayReadOrphans,
    },
  } as unknown as AuthenticatedSession;
}

describe('webhookDeliveryVisibilityWhere', () => {
  it('widens to orphaned deliveries when the policy permits an unattributed read', () => {
    expect(webhookDeliveryVisibilityWhere(sessionFor(true))).toEqual({
      OR: [{ subscription: { createdBy: ADMIN_ID } }, { subscriptionId: null }],
    });
  });

  it('is the owner clause alone, with no OR arm, when the policy refuses', () => {
    const where = webhookDeliveryVisibilityWhere(sessionFor(false));

    expect(where).toEqual({ subscription: { createdBy: ADMIN_ID } });
    expect(where).not.toHaveProperty('OR');
  });

  it("never names another admin's id on either branch", () => {
    for (const permit of [true, false]) {
      expect(JSON.stringify(webhookDeliveryVisibilityWhere(sessionFor(permit)))).not.toContain(
        OTHER_ID
      );
    }
  });
});

describe('webhookDeliveryAccessBasis', () => {
  it("names a delivery of the caller's own subscription 'owner', whatever the policy says", () => {
    for (const permit of [true, false]) {
      expect(
        webhookDeliveryAccessBasis({ subscription: { createdBy: ADMIN_ID } }, sessionFor(permit))
      ).toBe('owner');
    }
  });

  it("names an orphaned delivery 'orphan' when the policy permits", () => {
    expect(webhookDeliveryAccessBasis({ subscription: null }, sessionFor(true))).toBe('orphan');
  });

  it('refuses an orphaned delivery when the policy refuses', () => {
    expect(webhookDeliveryAccessBasis({ subscription: null }, sessionFor(false))).toBeNull();
  });

  it("refuses another admin's live delivery under both policy answers", () => {
    for (const permit of [true, false]) {
      expect(
        webhookDeliveryAccessBasis({ subscription: { createdBy: OTHER_ID } }, sessionFor(permit))
      ).toBeNull();
    }
  });

  it('refuses a delivery that was not found', () => {
    expect(webhookDeliveryAccessBasis(null, sessionFor(true))).toBeNull();
    expect(webhookDeliveryAccessBasis(undefined, sessionFor(true))).toBeNull();
  });
});
