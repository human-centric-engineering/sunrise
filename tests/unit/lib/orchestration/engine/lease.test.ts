/**
 * Unit tests for the execution lease helpers.
 *
 * Contract under test:
 *   generateLeaseToken    — returns unique UUID-shaped tokens
 *   leaseExpiry           — arithmetic: result is exactly LEASE_DURATION_MS after the base
 *   claimLease            — conditional UPDATE; wins when unclaimed or expired, loses when fresh lease present
 *   refreshLease          — token-scoped UPDATE; only the current owner can extend
 *   startHeartbeat        — periodic refresh; self-cancels on ownership loss or CAP consecutive throws; no timer leak
 *   HEARTBEAT_FAILURE_CAP — consecutive-failure threshold beyond which the heartbeat self-cancels
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── module mocks ────────────────────────────────────────────────────────────
// Must come before any import of the modules under test.

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── imports (after mocks) ────────────────────────────────────────────────────
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

import {
  HEARTBEAT_FAILURE_CAP,
  HEARTBEAT_INTERVAL_MS,
  LEASE_DURATION_MS,
  claimLease,
  generateLeaseToken,
  leaseExpiry,
  refreshLease,
  startHeartbeat,
} from '@/lib/orchestration/engine/lease';

// ─── typed mock references ───────────────────────────────────────────────────
const mockUpdateMany = vi.mocked(prisma.aiWorkflowExecution.updateMany);
const mockLoggerWarn = vi.mocked(logger.warn);
const mockLoggerError = vi.mocked(logger.error);

// ─── helpers ─────────────────────────────────────────────────────────────────
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── generateLeaseToken ───────────────────────────────────────────────────────
describe('generateLeaseToken', () => {
  it('returns a non-empty UUID-shaped string', () => {
    const token = generateLeaseToken();
    expect(token).toMatch(UUID_PATTERN);
  });

  it('successive calls return distinct values — uniqueness invariant', () => {
    const tokens = Array.from({ length: 10 }, () => generateLeaseToken());
    const unique = new Set(tokens);
    expect(unique.size).toBe(tokens.length);
  });
});

// ─── leaseExpiry ─────────────────────────────────────────────────────────────
describe('leaseExpiry', () => {
  it('returns a date exactly LEASE_DURATION_MS after an explicit base date', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    const result = leaseExpiry(base);
    expect(result.getTime()).toBe(base.getTime() + LEASE_DURATION_MS);
  });

  it('no-arg call uses the current time — result is within a small tolerance of now + LEASE_DURATION_MS', () => {
    const before = Date.now();
    const result = leaseExpiry();
    const after = Date.now();

    const resultMs = result.getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before + LEASE_DURATION_MS);
    // Allow 500 ms for the function call itself on a slow CI host
    expect(resultMs).toBeLessThanOrEqual(after + LEASE_DURATION_MS + 500);
  });
});

// ─── claimLease ──────────────────────────────────────────────────────────────
describe('claimLease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  // Happy path
  it('returns a non-null non-empty UUID token when the DB reports count 1 (won the race)', async () => {
    const token = await claimLease('exec-1', 'fresh-resume');
    expect(token).not.toBeNull();
    expect(token).toMatch(UUID_PATTERN);
  });

  it('returns null when the DB reports count 0 (another host holds a live lease)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const token = await claimLease('exec-1', 'fresh-resume');
    expect(token).toBeNull();
  });

  // WHERE clause structural integrity
  it('WHERE clause contains both the unclaimed arm (leaseToken: null) and the expired arm', async () => {
    await claimLease('exec-2', 'fresh-resume');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    const where = (call as { where: unknown }).where as {
      id: string;
      OR: Array<Record<string, unknown>>;
    };

    // Both OR arms must be present for correct mutual-exclusion semantics
    expect(where.OR).toHaveLength(2);
    const [nullArm, expiredArm] = where.OR;
    expect(nullArm).toHaveProperty('leaseToken', null);
    expect(expiredArm).toHaveProperty('leaseExpiresAt');
  });

  // Behavioural boundary: exact-now leaseExpiresAt is NOT claimable
  // The WHERE uses { lt: now }, meaning `leaseExpiresAt < now`, so a row whose lease
  // expires exactly AT now is NOT considered expired and must be left alone.
  it('uses strict lt comparison — a lease expiring exactly at now is NOT in the expired arm', async () => {
    await claimLease('exec-lt-boundary', 'fresh-resume');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    const where = (call as { where: unknown }).where as {
      OR: Array<Record<string, unknown>>;
    };

    const expiredArm = where.OR.find((arm) => 'leaseExpiresAt' in arm) as
      | { leaseExpiresAt: { lt: Date } }
      | undefined;
    expect(expiredArm).toBeDefined();
    // The comparison key must be 'lt' (strict less-than), not 'lte' (less-than-or-equal).
    // If this fails after someone changes lt→lte, this test catches the regression.
    expect(expiredArm!.leaseExpiresAt).toHaveProperty('lt');
    expect(expiredArm!.leaseExpiresAt).not.toHaveProperty('lte');
  });

  // Data payload
  it('data payload includes leaseToken, leaseExpiresAt, and lastHeartbeatAt', async () => {
    await claimLease('exec-3', 'fresh-resume');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const data = (call as { data: Record<string, unknown> }).data;

    expect(data).toHaveProperty('leaseToken');
    expect(typeof data['leaseToken']).toBe('string');
    expect(data['leaseToken']).toMatch(UUID_PATTERN);

    expect(data).toHaveProperty('leaseExpiresAt');
    expect(data['leaseExpiresAt']).toBeInstanceOf(Date);

    expect(data).toHaveProperty('lastHeartbeatAt');
    expect(data['lastHeartbeatAt']).toBeInstanceOf(Date);
  });

  // ClaimReason branch — orphan-resume increments, fresh-resume does not
  it('reason=orphan-resume → data includes { increment: 1 } for recoveryAttempts', async () => {
    await claimLease('exec-4', 'orphan-resume');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const data = (call as { data: Record<string, unknown> }).data;

    expect(data['recoveryAttempts']).toEqual({ increment: 1 });
  });

  it('reason=fresh-resume → data does NOT include recoveryAttempts key', async () => {
    await claimLease('exec-5', 'fresh-resume');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const data = (call as { data: Record<string, unknown> }).data;

    expect(data).not.toHaveProperty('recoveryAttempts');
  });

  // Behavioural: unclaimed row (leaseToken null) is claimable
  it('unclaimed row (leaseToken null) qualifies via the null arm of the OR clause', async () => {
    // The DB honours the WHERE by returning count: 1 for an unclaimed row.
    // We assert the WHERE contains the null-arm so a regression that removes it would be caught.
    mockUpdateMany.mockResolvedValue({ count: 1 });
    const token = await claimLease('exec-unclaimed', 'fresh-resume');
    expect(token).not.toBeNull();

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const where = (call as { where: { OR: Array<Record<string, unknown>> } }).where;
    expect(where.OR.some((arm) => arm['leaseToken'] === null)).toBe(true);
  });

  // Behavioural: expired row is claimable
  it('expired row qualifies via the leaseExpiresAt lt arm of the OR clause', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    const token = await claimLease('exec-expired', 'fresh-resume');
    expect(token).not.toBeNull();

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const where = (call as { where: { OR: Array<Record<string, unknown>> } }).where;
    expect(
      where.OR.some(
        (arm) =>
          typeof arm['leaseExpiresAt'] === 'object' &&
          arm['leaseExpiresAt'] !== null &&
          'lt' in arm['leaseExpiresAt']
      )
    ).toBe(true);
  });
});

// ─── refreshLease ─────────────────────────────────────────────────────────────
describe('refreshLease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('returns true when the DB confirms count 1 (caller still owns the lease)', async () => {
    const result = await refreshLease('exec-1', 'token-abc');
    expect(result).toBe(true);
  });

  it('returns false when count 0 — a stale token cannot refresh (cross-host isolation)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const result = await refreshLease('exec-1', 'stale-token');
    expect(result).toBe(false);
  });

  it('WHERE clause is token-scoped — contains both id and leaseToken', async () => {
    await refreshLease('exec-2', 'token-xyz');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const where = (call as { where: Record<string, unknown> }).where;

    expect(where['id']).toBe('exec-2');
    expect(where['leaseToken']).toBe('token-xyz');
    // No OR clause — refresh matches only the exact token holder
    expect(where).not.toHaveProperty('OR');
  });

  it('data payload includes leaseExpiresAt and lastHeartbeatAt', async () => {
    await refreshLease('exec-3', 'token-abc');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const data = (call as { data: Record<string, unknown> }).data;

    expect(data).toHaveProperty('leaseExpiresAt');
    expect(data['leaseExpiresAt']).toBeInstanceOf(Date);
    expect(data).toHaveProperty('lastHeartbeatAt');
    expect(data['lastHeartbeatAt']).toBeInstanceOf(Date);
  });

  it('data payload does NOT include leaseToken — refresh never rotates the token', async () => {
    await refreshLease('exec-4', 'token-abc');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const data = (call as { data: Record<string, unknown> }).data;

    expect(data).not.toHaveProperty('leaseToken');
  });

  // Cross-host isolation (behavioural)
  it('tokenA cannot refresh a row currently owned by tokenB — returns false', async () => {
    const ownerToken = 'token-owner';
    const stalerToken = 'token-stale';

    // Mock conditionally: only calls whose WHERE.leaseToken matches ownerToken get count: 1
    mockUpdateMany.mockImplementation(
      (args: any) =>
        Promise.resolve({ count: args.where?.leaseToken === ownerToken ? 1 : 0 }) as never
    );

    const ownerResult = await refreshLease('exec-shared', ownerToken);
    const staleResult = await refreshLease('exec-shared', stalerToken);

    expect(ownerResult).toBe(true);
    expect(staleResult).toBe(false);
  });
});

// ─── startHeartbeat ──────────────────────────────────────────────────────────
describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default: refreshLease succeeds (still owns the lease)
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Lifecycle
  it('returns a function (the cancel/stop fn)', () => {
    const stop = startHeartbeat('exec-1', 'token-abc');
    expect(typeof stop).toBe('function');
    stop();
  });

  it('setInterval is called with HEARTBEAT_INTERVAL_MS exactly', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    startHeartbeat('exec-1', 'token-abc');
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), HEARTBEAT_INTERVAL_MS);
    setIntervalSpy.mockRestore();
  });

  it('timer.unref() is called when unref is a function on the timer object', () => {
    // Node's setInterval returns a Timeout object with .unref(). Fake timers may or may not
    // provide this — we spy to confirm the source actually calls it when available.
    const unrefSpy = vi.fn();
    const originalSetInterval = globalThis.setInterval;
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation((fn: Parameters<typeof globalThis.setInterval>[0], delay?: number) => {
        const timer = originalSetInterval(fn, delay);
        // Attach a trackable unref spy
        (timer as unknown as { unref: () => void }).unref = unrefSpy;
        return timer;
      });

    startHeartbeat('exec-1', 'token-abc');
    expect(unrefSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });

  it('does not throw when unref is absent (graceful skip)', () => {
    const originalSetInterval = globalThis.setInterval;
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation((fn: Parameters<typeof globalThis.setInterval>[0], delay?: number) => {
        const timer = originalSetInterval(fn, delay);
        // Simulate an environment where unref is not available
        delete (timer as unknown as { unref?: unknown }).unref;
        return timer;
      });

    expect(() => {
      const stop = startHeartbeat('exec-1', 'token-abc');
      stop();
    }).not.toThrow();

    setIntervalSpy.mockRestore();
  });

  // Refresh tick — happy path
  it('on tick, refreshLease is invoked with the exact (executionId, leaseToken) pair', async () => {
    startHeartbeat('exec-tick', 'token-tick');

    // Before any tick: no DB call yet
    expect(mockUpdateMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const call = mockUpdateMany.mock.calls[0]?.[0];
    const where = (call as { where: Record<string, unknown> }).where;
    // refreshLease passes the token as leaseToken in the WHERE clause
    expect(where['id']).toBe('exec-tick');
    expect(where['leaseToken']).toBe('token-tick');
  });

  it('when refreshLease returns true, timer continues — a second tick fires another refresh', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const stop = startHeartbeat('exec-continues', 'token-abc');

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);

    stop();
  });

  it('when refreshLease returns true, clearInterval is NOT called during the tick', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const stop = startHeartbeat('exec-no-cancel', 'token-abc');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(clearIntervalSpy).not.toHaveBeenCalled();

    stop();
    clearIntervalSpy.mockRestore();
  });

  // Ownership-loss path
  it('when refreshLease returns false, logger.warn is emitted with the lost-ownership message', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    startHeartbeat('exec-lost', 'token-abc');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(/lease lost|another host/i),
      expect.objectContaining({ executionId: 'exec-lost' })
    );
  });

  it('after ownership loss, advancing timers does NOT produce additional refreshLease calls (self-cancel is observable)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    startHeartbeat('exec-self-cancel', 'token-abc');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);

    // Advance another full interval — if the timer were still running, this would call again
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    // Still only 1 call — the heartbeat cancelled itself
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  // Order-of-operations on ownership loss: stopped flag must be set BEFORE clearInterval
  // This protects against a re-entrant tick that fires between stopped=false and clearInterval.
  //
  // The sequenced-mock pattern: push markers into a shared array as each observable event fires,
  // then assert the array order. We can't read the private `stopped` variable directly, but we CAN
  // intercept clearInterval (which fires right after stopped=true) and the next DB call (which
  // would fire if stopped were still false). The observable proxy: clearInterval fires, then
  // ZERO subsequent DB calls — proving stopped was set before clearInterval ran.
  it('on ownership loss, stopped flag prevents re-entry before clearInterval completes (sequenced-mock order)', async () => {
    const callOrder: string[] = [];

    // Mock refreshLease to return false (count: 0) — ownership loss
    mockUpdateMany.mockImplementation(() => {
      callOrder.push('refreshLease');
      return Promise.resolve({ count: 0 }) as never;
    });

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation((id) => {
      callOrder.push('clearInterval');
      // Restore and call through so the timer actually stops
      clearIntervalSpy.mockRestore();
      clearInterval(id);
    });

    startHeartbeat('exec-order', 'token-abc');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    // Allow microtasks from the .then() chain to settle
    await Promise.resolve();

    callOrder.push('postSettlement');

    // A second interval advance should produce no further DB calls — stopped guard holds
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    // Order: refreshLease (tick fires) → clearInterval (ownership-loss handler) → postSettlement
    // No second refreshLease after clearInterval — proves stopped=true was set first
    expect(callOrder).toEqual(['refreshLease', 'clearInterval', 'postSettlement']);
    // DB call count confirms self-cancel is real, not nominal
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);

    clearIntervalSpy.mockRestore();
  });

  // Pre-cancel guard
  it('cancel fn called before first tick — tick body is skipped entirely, refreshLease not called', async () => {
    const stop = startHeartbeat('exec-pre-cancel', 'token-abc');

    // Cancel immediately before any tick fires
    stop();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    // Stopped flag was set before the tick ran — refreshLease should never be called
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  // Transient failure path
  it('refreshLease rejects with Error → logger.warn with executionId + err.message + consecutiveFailures, clearInterval NOT called below cap', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const boom = new Error('network timeout');
    mockUpdateMany.mockRejectedValue(boom);

    const stop = startHeartbeat('exec-transient', 'token-abc');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('heartbeat refresh failed'),
      expect.objectContaining({
        executionId: 'exec-transient',
        consecutiveFailures: 1,
        error: 'network timeout',
      })
    );
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    stop();
    clearIntervalSpy.mockRestore();
  });

  it('refreshLease rejects with non-Error value → logger.warn receives String(err)', async () => {
    mockUpdateMany.mockRejectedValue(42);

    startHeartbeat('exec-non-error', 'token-abc');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('heartbeat refresh failed'),
      expect.objectContaining({ error: '42' })
    );
  });

  it('transient failure: timer survives — subsequent successful ticks still call refreshLease', async () => {
    // First tick fails, second succeeds
    mockUpdateMany.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ count: 1 });

    const stop = startHeartbeat('exec-recovers', 'token-abc');

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);

    stop();
  });

  // Consecutive-failure cap — self-cancel after HEARTBEAT_FAILURE_CAP throws
  it(`self-cancels after ${HEARTBEAT_FAILURE_CAP} consecutive refresh throws — emits logger.error and stops further ticks`, async () => {
    mockUpdateMany.mockRejectedValue(new Error('persistent connection failure'));

    const stop = startHeartbeat('exec-cap', 'token-abc');

    // Advance through CAP consecutive failed ticks.
    for (let i = 0; i < HEARTBEAT_FAILURE_CAP; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    }

    expect(mockUpdateMany).toHaveBeenCalledTimes(HEARTBEAT_FAILURE_CAP);
    // The final consecutive-failure tick logs the error + stops the timer.
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('giving up after'),
      expect.objectContaining({ executionId: 'exec-cap', error: 'persistent connection failure' })
    );

    // After self-cancel, advancing past several more intervals must NOT produce more refreshLease calls.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);
    expect(mockUpdateMany).toHaveBeenCalledTimes(HEARTBEAT_FAILURE_CAP);

    stop();
  });

  it('consecutive-failure counter resets on a successful refresh — recovery prevents premature cap hit', async () => {
    // CAP-1 failures, then a success, then CAP-1 failures — total 2*(CAP-1) failures should NOT trip the cap
    // because the success in between resets the counter.
    const failuresBefore = HEARTBEAT_FAILURE_CAP - 1;
    const failuresAfter = HEARTBEAT_FAILURE_CAP - 1;

    for (let i = 0; i < failuresBefore; i++) {
      mockUpdateMany.mockRejectedValueOnce(new Error('blip-before'));
    }
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    for (let i = 0; i < failuresAfter; i++) {
      mockUpdateMany.mockRejectedValueOnce(new Error('blip-after'));
    }

    const stop = startHeartbeat('exec-reset', 'token-abc');

    const totalTicks = failuresBefore + 1 + failuresAfter;
    for (let i = 0; i < totalTicks; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    }

    expect(mockUpdateMany).toHaveBeenCalledTimes(totalTicks);
    // logger.error must NOT fire — the success between failure runs reset the counter
    expect(mockLoggerError).not.toHaveBeenCalled();

    stop();
  });

  // Cancel idempotency
  it('cancel fn called multiple times does not throw and stopped stays true (no additional ticks)', async () => {
    const stop = startHeartbeat('exec-idempotent', 'token-abc');

    stop();
    expect(() => stop()).not.toThrow();
    expect(() => stop()).not.toThrow();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
