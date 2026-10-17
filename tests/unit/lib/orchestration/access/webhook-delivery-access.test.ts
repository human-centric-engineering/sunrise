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
function sessionFor(
  mayReadOrphans: boolean,
  mayReadOrphanSubscriptions = false
): AuthenticatedSession {
  return {
    user: { id: ADMIN_ID, role: 'ADMIN' },
    principal: { userId: ADMIN_ID, role: 'ADMIN', credential: 'session' },
    unattributedReads: {
      conversation: !mayReadOrphans,
      dataset: !mayReadOrphans,
      execution: !mayReadOrphans,
      experiment: !mayReadOrphans,
      webhookDelivery: mayReadOrphans,
      webhookSubscription: mayReadOrphanSubscriptions,
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

  it('nests the subscription visibility in the mine clause, widened only by webhookSubscription', () => {
    // webhookDelivery refused, webhookSubscription permitted: the delivery's
    // orphan arm is gone but its subscription may still be a creatorless one.
    expect(webhookDeliveryVisibilityWhere(sessionFor(false, true))).toEqual({
      subscription: { OR: [{ createdBy: ADMIN_ID }, { createdBy: null }] },
    });
    // The reverse: orphaned deliveries are admitted, creatorless subscriptions are not.
    expect(webhookDeliveryVisibilityWhere(sessionFor(true, false))).toEqual({
      OR: [{ subscription: { createdBy: ADMIN_ID } }, { subscriptionId: null }],
    });
    // Both permitted: both arms widen.
    expect(webhookDeliveryVisibilityWhere(sessionFor(true, true))).toEqual({
      OR: [
        { subscription: { OR: [{ createdBy: ADMIN_ID }, { createdBy: null }] } },
        { subscriptionId: null },
      ],
    });
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

  it("names a delivery of a creatorless subscription 'orphan' when webhookSubscription is permitted", () => {
    expect(
      webhookDeliveryAccessBasis({ subscription: { createdBy: null } }, sessionFor(false, true))
    ).toBe('orphan');
  });

  it('refuses a delivery of a creatorless subscription when webhookSubscription is refused', () => {
    // webhookDelivery is permitted here, so reading the wrong key would admit it.
    expect(
      webhookDeliveryAccessBasis({ subscription: { createdBy: null } }, sessionFor(true, false))
    ).toBeNull();
  });

  it('refuses a delivery that was not found', () => {
    expect(webhookDeliveryAccessBasis(null, sessionFor(true))).toBeNull();
    expect(webhookDeliveryAccessBasis(undefined, sessionFor(true))).toBeNull();
  });
});
