/**
 * Unit Tests: webhook delivery visibility scope
 *
 * The same rule exists twice: as a Prisma `where` fragment for list routes and
 * as a predicate for single-row routes. They must agree.
 *
 * @see lib/orchestration/webhooks/delivery-scope.ts
 */

import { describe, it, expect } from 'vitest';

import {
  isWebhookDeliveryVisibleTo,
  webhookDeliveriesVisibleTo,
} from '@/lib/orchestration/webhooks/delivery-scope';

const ME = 'user-me';
const OTHER = 'user-other';

describe('webhookDeliveriesVisibleTo', () => {
  it('matches the creator’s deliveries OR orphans, and nothing else', () => {
    expect(webhookDeliveriesVisibleTo(ME)).toEqual({
      OR: [{ subscription: { createdBy: ME } }, { subscriptionId: null }],
    });
  });

  it('embeds the given user id, not a fixed one', () => {
    expect(webhookDeliveriesVisibleTo(OTHER)).toEqual({
      OR: [{ subscription: { createdBy: OTHER } }, { subscriptionId: null }],
    });
  });
});

describe('isWebhookDeliveryVisibleTo', () => {
  it('is visible to the subscription creator', () => {
    expect(isWebhookDeliveryVisibleTo({ subscription: { createdBy: ME } }, ME)).toBe(true);
  });

  it('is hidden from a different admin when the subscription is live', () => {
    expect(isWebhookDeliveryVisibleTo({ subscription: { createdBy: OTHER } }, ME)).toBe(false);
  });

  it('is visible to anyone when the subscription was deleted (orphan)', () => {
    expect(isWebhookDeliveryVisibleTo({ subscription: null }, ME)).toBe(true);
    expect(isWebhookDeliveryVisibleTo({ subscription: null }, OTHER)).toBe(true);
  });
});
