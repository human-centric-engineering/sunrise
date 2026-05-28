/**
 * Unit Test: touchAgentLastActive
 *
 * The helper is a fire-and-forget bump of `AiAgent.lastActiveAt`.
 * It must:
 *   - No-op when agentId is null/undefined/empty.
 *   - Call `prisma.aiAgent.update` with the given timestamp when present.
 *   - Default to `new Date()` when no timestamp is provided.
 *   - Swallow Prisma errors (the bump is a sort signal, not load-bearing).
 *
 * @see lib/orchestration/agents/touch-last-active.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockUpdate = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { touchAgentLastActive } from '@/lib/orchestration/agents/touch-last-active';
import { logger } from '@/lib/logging';

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({});
});

describe('touchAgentLastActive', () => {
  it('is a no-op for a null agentId', () => {
    touchAgentLastActive(null);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op for an undefined agentId', () => {
    touchAgentLastActive(undefined);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty string agentId', () => {
    touchAgentLastActive('');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('updates the agent with the provided timestamp', async () => {
    const at = new Date('2026-05-28T12:00:00.000Z');
    touchAgentLastActive('cmjbv4i3x00003wsloputgwul', at);
    // The helper does not await — flush the microtask queue.
    await Promise.resolve();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'cmjbv4i3x00003wsloputgwul' },
      data: { lastActiveAt: at },
    });
  });

  it('defaults to now() when no timestamp is provided', async () => {
    const before = new Date();
    touchAgentLastActive('cmjbv4i3x00003wsloputgwul');
    await Promise.resolve();
    const after = new Date();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const { data } = mockUpdate.mock.calls[0][0] as { data: { lastActiveAt: Date } };
    expect(data.lastActiveAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(data.lastActiveAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('swallows Prisma errors and logs at debug', async () => {
    const err = new Error('db down');
    mockUpdate.mockRejectedValueOnce(err);

    // No throw, even though the update rejects.
    expect(() => touchAgentLastActive('cmjbv4i3x00003wsloputgwul')).not.toThrow();

    // Wait two microtask ticks for the catch handler to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.debug).toHaveBeenCalledWith(
      'touchAgentLastActive failed (non-fatal)',
      expect.objectContaining({
        agentId: 'cmjbv4i3x00003wsloputgwul',
        error: 'db down',
      })
    );
  });
});
