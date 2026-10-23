/**
 * Tests for `lib/orchestration/config-versions.ts` (§122 t-899).
 *
 * Each version must change on what erasure does to its record, and on what a
 * save could overwrite, and must not change on fields no save writes.
 *
 * @see lib/orchestration/config-versions.ts
 */

import { describe, expect, it, vi } from 'vitest';

import {
  escalationVersion,
  lockScheduleRow,
  lockSettingsRow,
  lockSubscriptionRow,
  scheduleVersion,
  SCHEDULE_VERSION_SELECT,
  subscriptionVersion,
  SUBSCRIPTION_VERSION_SELECT,
} from '@/lib/orchestration/config-versions';

const SUBSCRIPTION = {
  channel: 'email',
  url: null,
  emailAddress: 'jane@example.com',
  events: ['workflow_failed'],
  agentIds: [],
  workflowIds: [],
  isActive: true,
  description: null,
  maxAttempts: 3,
  retryBackoffMs: [10000, 60000],
};

const SCHEDULE = {
  name: 'Digest',
  cronExpression: '0 9 * * *',
  inputTemplate: { sendTo: 'jane@example.com' },
  isEnabled: true,
  scope: null,
};

describe('subscriptionVersion', () => {
  it('changes on what erasure does to a subscription: address cleared, switched off', () => {
    expect(subscriptionVersion({ ...SUBSCRIPTION, emailAddress: null, isActive: false })).not.toBe(
      subscriptionVersion(SUBSCRIPTION)
    );
  });

  it.each(Object.keys(SUBSCRIPTION_VERSION_SELECT))('changes when %s changes', (field) => {
    const changed = { ...SUBSCRIPTION, [field]: field === 'isActive' ? false : ['changed'] };
    expect(subscriptionVersion(changed as never)).not.toBe(subscriptionVersion(SUBSCRIPTION));
  });

  it('ignores fields outside its select (the secret, timestamps)', () => {
    const withExtras = { ...SUBSCRIPTION, secret: 's', updatedAt: new Date() };
    expect(subscriptionVersion(withExtras)).toBe(subscriptionVersion(SUBSCRIPTION));
  });
});

describe('scheduleVersion', () => {
  it('changes on what erasure does to a schedule: an address blanked in the template', () => {
    expect(scheduleVersion({ ...SCHEDULE, inputTemplate: { sendTo: '' } })).not.toBe(
      scheduleVersion(SCHEDULE)
    );
  });

  it.each(Object.keys(SCHEDULE_VERSION_SELECT))('changes when %s changes', (field) => {
    const changed = { ...SCHEDULE, [field]: field === 'isEnabled' ? false : 'changed' };
    expect(scheduleVersion(changed as never)).not.toBe(scheduleVersion(SCHEDULE));
  });

  it('ignores what the tick moves on every firing', () => {
    const fired = { ...SCHEDULE, nextRunAt: new Date(), lastRunAt: new Date() };
    expect(scheduleVersion(fired)).toBe(scheduleVersion(SCHEDULE));
  });
});

describe('escalationVersion', () => {
  it('changes when erasure takes an address off the list', () => {
    expect(escalationVersion({ emailAddresses: ['ops@example.com'] })).not.toBe(
      escalationVersion({ emailAddresses: ['ops@example.com', 'jane@example.com'] })
    );
  });

  it('reads an unset list as null either way', () => {
    expect(escalationVersion(undefined)).toBe(escalationVersion(null));
  });

  it('is not any other record kind’s version for the same content', () => {
    expect(escalationVersion(null)).not.toBe(scheduleVersion(SCHEDULE));
  });
});

describe('row locks', () => {
  it.each([
    [
      'subscription',
      lockSubscriptionRow,
      /FROM ai_webhook_subscription WHERE id = \? FOR NO KEY UPDATE/,
    ],
    ['schedule', lockScheduleRow, /FROM ai_workflow_schedule WHERE id = \? FOR NO KEY UPDATE/],
    [
      'settings',
      lockSettingsRow,
      /FROM ai_orchestration_settings WHERE slug = \? FOR NO KEY UPDATE/,
    ],
  ])('locks the %s row the way erasure does', async (_label, lock, sql) => {
    const $queryRaw = vi.fn(async () => []);
    await lock({ $queryRaw } as never, 'key-1');

    const [strings, key] = $queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, string];
    expect(strings.join('?')).toMatch(sql);
    expect(key).toBe('key-1');
  });
});
