/**
 * Tests for the `022-delivery-destinations` seed (§109 t-739): backfills NULL
 * destinations on webhook and event-hook deliveries from the current parent.
 *
 * @see prisma/seeds/022-delivery-destinations.ts
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: {
    TENANCY_MODE: 'single',
    BETTER_AUTH_SECRET: 'seed-test-secret-at-least-thirty-two-characters',
  },
}));

import unit from '@/prisma/seeds/022-delivery-destinations';
import type { SeedContext } from '@/prisma/runner';
import { getTenantContext } from '@/lib/tenancy/context';
import {
  describeDestination,
  subscriptionDestination,
} from '@/lib/orchestration/webhooks/destination';

function makeCtx(opts: {
  subs?: Array<Record<string, unknown>>;
  hooks?: Array<Record<string, unknown>>;
}) {
  const scopes: Array<ReturnType<typeof getTenantContext>> = [];
  const seen = () => {
    scopes.push(getTenantContext());
  };
  const prisma = {
    aiWebhookSubscription: {
      findMany: vi.fn().mockImplementation(async () => {
        seen();
        return opts.subs ?? [];
      }),
    },
    aiWebhookDelivery: {
      updateMany: vi.fn().mockImplementation(async () => {
        seen();
        return { count: 2 };
      }),
    },
    aiEventHook: {
      findMany: vi.fn().mockImplementation(async () => {
        seen();
        return opts.hooks ?? [];
      }),
    },
    aiEventHookDelivery: {
      updateMany: vi.fn().mockImplementation(async () => {
        seen();
        return { count: 3 };
      }),
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { ctx: { prisma, logger } as unknown as SeedContext, prisma, logger, scopes };
}

const webhookSub = {
  id: 'sub-1',
  channel: 'webhook',
  url: 'https://hooks.example.com/services/Ab3dEf6hIj9kLm2nOp5qRs8t?k=v',
  emailAddress: null,
};

describe('022-delivery-destinations seed', () => {
  it('selects only parents that still have a delivery with a NULL destination', async () => {
    const { ctx, prisma } = makeCtx({});

    await unit.run(ctx);

    expect(prisma.aiWebhookSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deliveries: { some: { destination: null } } } })
    );
    expect(prisma.aiEventHook.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deliveries: { some: { destination: null } } } })
    );
  });

  it('backfills webhook rows by subscription with the computed pair, targeting only NULL rows', async () => {
    const { ctx, prisma } = makeCtx({ subs: [webhookSub] });

    await unit.run(ctx);

    const expected = describeDestination('webhook', webhookSub.url);
    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub-1', destination: null },
      data: expected,
    });
    // The write carries the origin only, never the raw secret-bearing URL.
    expect(expected.destination).toBe('https://hooks.example.com');
    expect(JSON.stringify(expected)).not.toContain('Ab3dEf6hIj9kLm2nOp5qRs8t');
  });

  it('backfills an email subscription from its address', async () => {
    const sub = { id: 'sub-e', channel: 'email', url: null, emailAddress: 'ops@example.com' };
    const { ctx, prisma } = makeCtx({ subs: [sub] });

    await unit.run(ctx);

    expect(prisma.aiWebhookDelivery.updateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub-e', destination: null },
      data: subscriptionDestination(sub),
    });
    expect(subscriptionDestination(sub)?.destination).toBe('ops@example.com');
  });

  it('skips a subscription with no destination while still processing the others', async () => {
    const noUrl = { id: 'sub-none', channel: 'webhook', url: null, emailAddress: null };
    const { ctx, prisma } = makeCtx({ subs: [noUrl, webhookSub] });

    await unit.run(ctx);

    const targeted = prisma.aiWebhookDelivery.updateMany.mock.calls.map(
      (c) => (c[0] as { where: { subscriptionId: string } }).where.subscriptionId
    );
    expect(targeted).toEqual(['sub-1']);
  });

  it('backfills hook rows from a valid webhook action', async () => {
    const hook = {
      id: 'hook-1',
      action: { type: 'webhook', url: 'https://example.com/hook/Ab3dEf6hIj9kLm2nOp5qRs8t' },
    };
    const { ctx, prisma } = makeCtx({ hooks: [hook] });

    await unit.run(ctx);

    expect(prisma.aiEventHookDelivery.updateMany).toHaveBeenCalledWith({
      where: { hookId: 'hook-1', destination: null },
      data: describeDestination('webhook', hook.action.url),
    });
  });

  it('skips a hook whose action fails WebhookActionSchema, but still backfills a valid one', async () => {
    const bad = { id: 'hook-bad', action: { type: 'webhook', url: 'http://localhost:8080/x' } };
    const notWebhook = { id: 'hook-legacy', action: { type: 'internal', handler: 'noop' } };
    const good = { id: 'hook-ok', action: { type: 'webhook', url: 'https://example.com/ok' } };
    const { ctx, prisma } = makeCtx({ hooks: [bad, notWebhook, good] });

    await unit.run(ctx);

    const targeted = prisma.aiEventHookDelivery.updateMany.mock.calls.map(
      (c) => (c[0] as { where: { hookId: string } }).where.hookId
    );
    expect(targeted).toEqual(['hook-ok']);
  });

  it('runs every query inside the system tenant scope', async () => {
    const { ctx, scopes } = makeCtx({
      subs: [webhookSub],
      hooks: [{ id: 'h', action: { type: 'webhook', url: 'https://example.com/ok' } }],
    });
    expect(getTenantContext()).toBeNull();

    await unit.run(ctx);

    // 2 findMany + 1 webhook updateMany + 1 hook updateMany
    expect(scopes).toHaveLength(4);
    for (const scope of scopes) {
      expect(scope).toMatchObject({ source: 'system', orgId: null });
    }
  });

  it('reports the summed counts from the updates', async () => {
    const { ctx, logger } = makeCtx({
      subs: [webhookSub],
      hooks: [{ id: 'h', action: { type: 'webhook', url: 'https://example.com/ok' } }],
    });

    await unit.run(ctx);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('backfilled 2 webhook and 3 event-hook deliveries')
    );
  });
});
