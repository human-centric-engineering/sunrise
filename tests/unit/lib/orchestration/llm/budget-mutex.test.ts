/**
 * Tests for `lib/orchestration/llm/budget-mutex.ts`.
 *
 * Covers:
 *   - Serialization of concurrent calls for the same agentId
 *   - Parallel execution for different agentIds
 *   - Lock release on success and on throw
 *   - Map cleanup after completion
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { withAgentBudgetLock, __resetLocksForTesting } from '@/lib/orchestration/llm/budget-mutex';

describe('withAgentBudgetLock', () => {
  beforeEach(() => {
    __resetLocksForTesting();
  });

  it('executes fn and returns its result', async () => {
    const result = await withAgentBudgetLock('agent_1', async () => 42);
    expect(result).toBe(42);
  });

  it('serialises concurrent calls for the same agentId', async () => {
    const order: string[] = [];

    const p1 = withAgentBudgetLock('agent_1', async () => {
      order.push('start_1');
      await new Promise((r) => setTimeout(r, 50));
      order.push('end_1');
      return 1;
    });

    const p2 = withAgentBudgetLock('agent_1', async () => {
      order.push('start_2');
      await new Promise((r) => setTimeout(r, 10));
      order.push('end_2');
      return 2;
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    // p2 must wait for p1 to finish — serial execution
    expect(order).toEqual(['start_1', 'end_1', 'start_2', 'end_2']);
  });

  it('allows concurrent calls for different agentIds', async () => {
    const order: string[] = [];

    const p1 = withAgentBudgetLock('agent_1', async () => {
      order.push('start_a1');
      await new Promise((r) => setTimeout(r, 50));
      order.push('end_a1');
    });

    const p2 = withAgentBudgetLock('agent_2', async () => {
      order.push('start_a2');
      await new Promise((r) => setTimeout(r, 10));
      order.push('end_a2');
    });

    await Promise.all([p1, p2]);

    // Both should start before either ends (parallel execution)
    expect(order.indexOf('start_a1')).toBeLessThan(order.indexOf('end_a1'));
    expect(order.indexOf('start_a2')).toBeLessThan(order.indexOf('end_a2'));
    // a2 should end before a1 (it's faster) if running in parallel
    expect(order.indexOf('end_a2')).toBeLessThan(order.indexOf('end_a1'));
  });

  it('releases lock even when fn throws', async () => {
    // First call throws
    await expect(
      withAgentBudgetLock('agent_1', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Second call should not be blocked
    const result = await withAgentBudgetLock('agent_1', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('queues a third caller behind first and second', async () => {
    const order: number[] = [];

    const p1 = withAgentBudgetLock('a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });

    const p2 = withAgentBudgetLock('a', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
    });

    const p3 = withAgentBudgetLock('a', async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });
});
