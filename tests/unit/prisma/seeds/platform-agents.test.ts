/**
 * Tests: the `021-platform-agents` seed unit (§116 t-724).
 *
 * The unit is a loop: every ACTIVE org, one reconcile each, on the runner's own
 * client (the owner connection at `multi`). What the reconcile does is tested
 * against its properties in `reconcile-platform-agents.test.ts`; this pins the
 * loop — that it reaches every org rather than the install org only, which is
 * the whole difference from the eight seeds it replaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SeedContext } from '@/prisma/runner';

const mockReconcile = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/agents/reconcile-platform-agents', () => ({
  reconcilePlatformAgents: mockReconcile,
}));
// The shared client: the unit must use the runner's own, so this must never
// be reached.
const sharedFindMany = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: { org: { findMany: sharedFindMany } } }));

import platformAgentsSeed from '@/prisma/seeds/021-platform-agents';

function makeCtx(orgIds: string[]) {
  const orgFindMany = vi.fn().mockResolvedValue(orgIds.map((id) => ({ id })));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = { prisma: { org: { findMany: orgFindMany } }, logger } as unknown as SeedContext;
  return { ctx, orgFindMany, logger };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReconcile.mockResolvedValue({
    created: ['a'],
    updated: [],
    unchanged: [],
    deactivated: [],
    refused: [],
  });
});

describe('021-platform-agents', () => {
  it('reconciles every active org on the runner’s own client', async () => {
    const { ctx, orgFindMany, logger } = makeCtx(['install', 'org_b']);

    await platformAgentsSeed.run(ctx);

    expect(orgFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE' } })
    );
    expect(sharedFindMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the shared client must not be used at all
    expect(mockReconcile.mock.calls).toEqual([
      ['install', { db: ctx.prisma, log: logger }],
      ['org_b', { db: ctx.prisma, log: logger }],
    ]);
  });

  it('reports an org whose own agent held a platform slug', async () => {
    const { ctx, logger } = makeCtx(['install']);
    mockReconcile.mockResolvedValue({
      created: [],
      updated: [],
      unchanged: ['a'],
      deactivated: [],
      refused: [{ slug: 'quiz-master', reason: 'tenant-agent' }],
    });

    await platformAgentsSeed.run(ctx);

    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/install: .*, 1 refused$/));
  });

  it('lets a reconcile failure fail the seed run', async () => {
    // The runner records the unit as applied only when run() resolves, so a
    // swallowed failure would stop it re-running on the next seed.
    const { ctx } = makeCtx(['install']);
    mockReconcile.mockRejectedValue(new Error('boom'));

    await expect(platformAgentsSeed.run(ctx)).rejects.toThrow('boom');
  });

  it('hashes every file a definition or the reconcile lives in', async () => {
    const { readdirSync } = await import('node:fs');
    const definitions = readdirSync('lib/orchestration/agents/platform-agent-definitions').map(
      (f) => `../../lib/orchestration/agents/platform-agent-definitions/${f}`
    );

    expect(platformAgentsSeed.name).toBe('021-platform-agents');
    expect(platformAgentsSeed.hashInputs).toEqual(
      expect.arrayContaining([
        '../../lib/orchestration/agents/platform-agents.ts',
        '../../lib/orchestration/agents/reconcile-platform-agents.ts',
        '../../lib/app/platform-agents.ts',
        ...definitions,
      ])
    );
  });
});
