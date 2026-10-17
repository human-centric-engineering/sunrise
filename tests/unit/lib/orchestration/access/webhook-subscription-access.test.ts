/**
 * Unit Test: webhook subscription access authorization (t-782)
 *
 * @see lib/orchestration/access/webhook-subscription-access.ts
 *
 * A subscription outlives the admin who created it (`createdBy` is `SetNull`),
 * so the orphan arm is the policy's answer
 * (`session.unattributedReads.webhookSubscription`). Every case runs with the
 * answer both ways, and the neighbouring kinds are set to the opposite value so
 * a helper reading the wrong key goes red.
 */

import { describe, it, expect } from 'vitest';

import {
  webhookSubscriptionAccessBasis,
  webhookSubscriptionVisibilityWhere,
} from '@/lib/orchestration/access/webhook-subscription-access';
import type { AuthenticatedSession } from '@/lib/auth/guards';

const ADMIN_ID = 'admin-1';
const OTHER_ID = 'admin-2';

function sessionFor(mayReadOrphans: boolean): AuthenticatedSession {
  return {
    user: { id: ADMIN_ID, role: 'ADMIN' },
    principal: { userId: ADMIN_ID, role: 'ADMIN', credential: 'session' },
    unattributedReads: {
      conversation: !mayReadOrphans,
      dataset: !mayReadOrphans,
      execution: !mayReadOrphans,
      experiment: !mayReadOrphans,
      webhookDelivery: !mayReadOrphans,
      webhookSubscription: mayReadOrphans,
    },
  } as unknown as AuthenticatedSession;
}

describe('webhookSubscriptionVisibilityWhere', () => {
  it('widens to creatorless subscriptions when the policy permits an unattributed read', () => {
    expect(webhookSubscriptionVisibilityWhere(sessionFor(true))).toEqual({
      OR: [{ createdBy: ADMIN_ID }, { createdBy: null }],
    });
  });

  it('is the owner clause alone, with no OR arm, when the policy refuses', () => {
    const where = webhookSubscriptionVisibilityWhere(sessionFor(false));

    expect(where).toEqual({ createdBy: ADMIN_ID });
    expect(where).not.toHaveProperty('OR');
  });

  it("never names another admin's id on either branch", () => {
    for (const permit of [true, false]) {
      expect(JSON.stringify(webhookSubscriptionVisibilityWhere(sessionFor(permit)))).not.toContain(
        OTHER_ID
      );
    }
  });
});

describe('webhookSubscriptionAccessBasis', () => {
  it("names the caller's own subscription 'owner', whatever the policy says", () => {
    for (const permit of [true, false]) {
      expect(webhookSubscriptionAccessBasis({ createdBy: ADMIN_ID }, sessionFor(permit))).toBe(
        'owner'
      );
    }
  });

  it("names a creatorless subscription 'orphan' when the policy permits", () => {
    expect(webhookSubscriptionAccessBasis({ createdBy: null }, sessionFor(true))).toBe('orphan');
  });

  it('refuses a creatorless subscription when the policy refuses', () => {
    expect(webhookSubscriptionAccessBasis({ createdBy: null }, sessionFor(false))).toBeNull();
  });

  it("refuses another admin's subscription under both policy answers", () => {
    for (const permit of [true, false]) {
      expect(
        webhookSubscriptionAccessBasis({ createdBy: OTHER_ID }, sessionFor(permit))
      ).toBeNull();
    }
  });

  it('refuses a subscription that was not found', () => {
    expect(webhookSubscriptionAccessBasis(null, sessionFor(true))).toBeNull();
    expect(webhookSubscriptionAccessBasis(undefined, sessionFor(true))).toBeNull();
  });
});
