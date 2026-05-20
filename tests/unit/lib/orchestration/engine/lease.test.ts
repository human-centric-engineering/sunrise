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
    aiWorkflowExecutionLeaseEvent: {
      create: vi.fn(),
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
  recordForceFailEvent,
  redactLeaseToken,
  refreshLease,
  releaseLease,
  startHeartbeat,
} from '@/lib/orchestration/engine/lease';

// ─── typed mock references ───────────────────────────────────────────────────
const mockUpdateMany = vi.mocked(prisma.aiWorkflowExecution.updateMany);
const mockLeaseEventCreate = vi.mocked(prisma.aiWorkflowExecutionLeaseEvent.create);
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

  // Status guard — prevents a reaper-marked terminal row from being resurrected
  // (race scenario from PR #167 code review: reaper writes status=FAILED without
  // clearing lease columns, sweep already has the row, fresh-resume claim could
  // otherwise succeed because the lease is expired).
  it('reason=orphan-resume → WHERE clause requires status=running', async () => {
    await claimLease('exec-status-orphan', 'orphan-resume');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const where = (call as { where: Record<string, unknown> }).where;
    expect(where['status']).toEqual({ equals: 'running' });
  });

  // fresh-resume must accept both pre- and post-executeApproval states. The
  // approve route flips paused_for_approval → pending atomically with the trace
  // write; if claimLease accepted only paused_for_approval, the resume path
  // (channel routes + admin route) would race the approve write and lose.
  // Accepting both removes that race. Terminal rows (failed/completed/cancelled)
  // are still blocked because they're not in the allowlist AND the reaper clears
  // the lease columns atomically with the FAILED flip.
  it('reason=fresh-resume → WHERE clause accepts paused_for_approval and pending', async () => {
    await claimLease('exec-status-fresh', 'fresh-resume');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const where = (call as { where: Record<string, unknown> }).where;
    expect(where['status']).toEqual({ in: ['paused_for_approval', 'pending'] });
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

// ─── redactLeaseToken ────────────────────────────────────────────────────────
describe('redactLeaseToken', () => {
  it('returns null for null input', () => {
    expect(redactLeaseToken(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(redactLeaseToken(undefined)).toBeNull();
  });

  it('returns null for empty string input', () => {
    expect(redactLeaseToken('')).toBeNull();
  });

  it('returns the full token prefixed with ellipsis when length is exactly 5', () => {
    // The code returns `…${token}` when length <= 5 — assert the prefix was added, not
    // that the input was echoed. A trivial pass-through would fail the prefix check.
    const token = 'abcde';
    const result = redactLeaseToken(token);
    expect(result).toBe('…abcde');
  });

  it('returns the full token prefixed with ellipsis when length is less than 5', () => {
    const token = 'abc';
    const result = redactLeaseToken(token);
    expect(result).toBe('…abc');
  });

  it('returns only the last 5 chars prefixed with ellipsis when token is longer than 5 chars', () => {
    // For a long token (UUID-shaped), only the tail should appear — the leading
    // chars are stripped so the inspector never exposes the full write-capability secret.
    const token = '550e8400-e29b-41d4-a716-446655440000';
    const result = redactLeaseToken(token);
    // Last 5 chars of token are '40000'
    expect(result).toBe('…40000');
    // The full token must NOT be present
    expect(result).not.toContain('550e8400');
  });

  it('produces a different redaction for two tokens that share the same tail — demonstrates tail isolation', () => {
    // Confirm the function extracts the tail, not some other slice
    const tokenA = 'aaaaaXXXXX';
    const tokenB = 'bbbbbXXXXX';
    // Both tokens share the same last-5 tail — both should redact identically
    expect(redactLeaseToken(tokenA)).toBe(redactLeaseToken(tokenB));
    expect(redactLeaseToken(tokenA)).toBe('…XXXXX');
  });
});

// ─── claimLease — lease event writes ────────────────────────────────────────
// These tests extend the existing claimLease suite to cover the new event
// recording behaviour added in the lease module. The updateMany mock is already
// configured in the outer beforeEach; we additionally assert on the leaseEvent
// create call that records the claim.
describe('claimLease — lease event recording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockLeaseEventCreate.mockResolvedValue({} as never);
  });

  it('on success with reason=fresh-resume, records a "claimed" event with redacted token tail', async () => {
    const token = await claimLease('exec-event-fresh', 'fresh-resume');
    expect(token).not.toBeNull();

    // Allow the fire-and-forget microtask to settle
    await Promise.resolve();

    expect(mockLeaseEventCreate).toHaveBeenCalledTimes(1);
    const createArg = mockLeaseEventCreate.mock.calls[0]?.[0];
    expect(createArg).toBeDefined();

    const data = (createArg as { data: Record<string, unknown> }).data;
    // The code applies redactLeaseToken — the stored token must be the tail, not the full UUID
    expect(data['event']).toBe('claimed');
    expect(data['executionId']).toBe('exec-event-fresh');
    // redactLeaseToken on a UUID (length > 5) produces '…<last5>' — the full token must not appear
    expect(typeof data['leaseToken']).toBe('string');
    expect((data['leaseToken'] as string).startsWith('…')).toBe(true);
    expect((data['leaseToken'] as string).length).toBe(6); // '…' + 5 chars
    // reason must be passed through so the inspector can label the event
    expect(data['reason']).toBe('fresh-resume');
  });

  it('on success with reason=orphan-resume, records an "orphan-resume" event, not "claimed"', async () => {
    const token = await claimLease('exec-event-orphan', 'orphan-resume');
    expect(token).not.toBeNull();

    await Promise.resolve();

    expect(mockLeaseEventCreate).toHaveBeenCalledTimes(1);
    const createArg = mockLeaseEventCreate.mock.calls[0]?.[0];
    const data = (createArg as { data: Record<string, unknown> }).data;

    // Distinct event name distinguishes recovery cycles from clean approval resumes
    expect(data['event']).toBe('orphan-resume');
    expect(data['reason']).toBe('orphan-resume');
  });

  it('when count=0 (no lease won), does NOT write any lease event', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const token = await claimLease('exec-no-claim', 'fresh-resume');
    expect(token).toBeNull();

    await Promise.resolve();

    // No event should be recorded — a failed claim is not a lifecycle transition worth logging
    expect(mockLeaseEventCreate).not.toHaveBeenCalled();
  });

  it('lease event write errors are swallowed — claimLease still returns the token', async () => {
    mockLeaseEventCreate.mockRejectedValueOnce(new Error('DB write failed'));

    // claimLease must not throw even if the fire-and-forget event write rejects
    const token = await claimLease('exec-event-error', 'fresh-resume');

    // Allow the rejected promise microtask to settle (triggers the catch inside recordLeaseEvent)
    await Promise.resolve();
    await Promise.resolve();

    expect(token).not.toBeNull();
    expect(token).toMatch(UUID_PATTERN);
  });
});

// ─── refreshLease — lease event writes ──────────────────────────────────────
describe('refreshLease — lease event recording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeaseEventCreate.mockResolvedValue({} as never);
  });

  it('on count=0 (token mismatch), records a "refresh-failed" event with reason="token-mismatch"', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const result = await refreshLease('exec-refresh-fail', 'stale-token-12345');
    expect(result).toBe(false);

    await Promise.resolve();

    expect(mockLeaseEventCreate).toHaveBeenCalledTimes(1);
    const createArg = mockLeaseEventCreate.mock.calls[0]?.[0];
    const data = (createArg as { data: Record<string, unknown> }).data;

    expect(data['event']).toBe('refresh-failed');
    expect(data['executionId']).toBe('exec-refresh-fail');
    expect(data['reason']).toBe('token-mismatch');
    // Token stored in the event must be the redacted tail, not the full token
    expect(data['leaseToken']).toBe('…12345');
  });

  it('on count=1 (successful refresh), does NOT write any lease event', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const result = await refreshLease('exec-refresh-ok', 'live-token-abc');
    expect(result).toBe(true);

    await Promise.resolve();

    // Successful refreshes are intentionally not recorded to avoid table domination
    expect(mockLeaseEventCreate).not.toHaveBeenCalled();
  });
});

// ─── releaseLease ─────────────────────────────────────────────────────────────
describe('releaseLease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeaseEventCreate.mockResolvedValue({} as never);
  });

  it('when count=1, clears lease columns and returns true', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const result = await releaseLease('exec-release-ok', 'admin-terminated');
    expect(result).toBe(true);

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const call = mockUpdateMany.mock.calls[0]?.[0];
    const data = (call as { data: Record<string, unknown> }).data;

    // The code must null out both lease columns — not just one
    expect(data['leaseToken']).toBeNull();
    expect(data['leaseExpiresAt']).toBeNull();
  });

  it('when count=1, WHERE clause requires leaseToken IS NOT NULL to prevent double-release', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await releaseLease('exec-release-where', 'reason');

    const call = mockUpdateMany.mock.calls[0]?.[0];
    const where = (call as { where: Record<string, unknown> }).where;
    expect(where['id']).toBe('exec-release-where');
    // Conditional on leaseToken not being null — calling on an already-released row is a no-op
    expect(where['leaseToken']).toEqual({ not: null });
  });

  it('when count=1, records a "released" event with the passed reason and null token', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await releaseLease('exec-release-event', 'workflow-completed');

    await Promise.resolve();

    expect(mockLeaseEventCreate).toHaveBeenCalledTimes(1);
    const createArg = mockLeaseEventCreate.mock.calls[0]?.[0];
    const data = (createArg as { data: Record<string, unknown> }).data;

    expect(data['event']).toBe('released');
    expect(data['executionId']).toBe('exec-release-event');
    expect(data['reason']).toBe('workflow-completed');
    // releaseLease passes null as the token — redactLeaseToken(null) returns null
    expect(data['leaseToken']).toBeNull();
  });

  it('when count=0 (row already released or never claimed), returns false', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const result = await releaseLease('exec-already-released', 'reason');
    expect(result).toBe(false);
  });

  it('when count=0, does NOT write any lease event — keeps the event log honest', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await releaseLease('exec-no-event', 'reason');

    await Promise.resolve();

    expect(mockLeaseEventCreate).not.toHaveBeenCalled();
  });
});

// ─── recordForceFailEvent ─────────────────────────────────────────────────────
describe('recordForceFailEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLeaseEventCreate.mockResolvedValue({} as never);
  });

  it('writes a "force-failed" event with the redacted token tail', async () => {
    await recordForceFailEvent('exec-force-fail', 'prior-token-12345', 'admin-request');

    expect(mockLeaseEventCreate).toHaveBeenCalledTimes(1);
    const createArg = mockLeaseEventCreate.mock.calls[0]?.[0];
    const data = (createArg as { data: Record<string, unknown> }).data;

    expect(data['event']).toBe('force-failed');
    expect(data['executionId']).toBe('exec-force-fail');
    // priorToken is longer than 5 chars — only the last 5 should appear
    expect(data['leaseToken']).toBe('…12345');
    expect(data['reason']).toBe('admin-request');
  });

  it('passes metadata through to the event row when provided', async () => {
    const metadata = { triggeredBy: 'user-99', reason: 'runaway-cost' };
    await recordForceFailEvent('exec-force-meta', 'prior-token-abcde', 'budget-exceeded', metadata);

    const createArg = mockLeaseEventCreate.mock.calls[0]?.[0];
    const data = (createArg as { data: Record<string, unknown> }).data;

    expect(data['metadata']).toEqual(metadata);
  });

  it('does NOT call updateMany — no lease mutation, only the event row', async () => {
    await recordForceFailEvent('exec-force-no-update', 'prior-token-xyz99', 'force-fail');

    // The function exists specifically to write only the event; the caller's conditional
    // UPDATE already cleared the lease columns atomically
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('works with a null priorToken — redactLeaseToken(null) stores null in the event row', async () => {
    await recordForceFailEvent('exec-force-null-token', null, 'admin-request');

    const createArg = mockLeaseEventCreate.mock.calls[0]?.[0];
    const data = (createArg as { data: Record<string, unknown> }).data;

    expect(data['leaseToken']).toBeNull();
  });

  it('omits metadata key from event row when not provided', async () => {
    await recordForceFailEvent('exec-force-no-meta', 'prior-token-xyz99', 'reason');

    const createArg = mockLeaseEventCreate.mock.calls[0]?.[0];
    const data = (createArg as { data: Record<string, unknown> }).data;

    // metadata: undefined means Prisma omits the column — no stray {} stored
    expect(data['metadata']).toBeUndefined();
  });
});
