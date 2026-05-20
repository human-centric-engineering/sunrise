/**
 * Tests for the live-engine snapshot module.
 *
 * Test Coverage:
 * - getLiveEngineSnapshot: empty system, single running step, parallel fan-out
 *   reduction, mixed states, pending with no rows, orphaned independence,
 *   provider pass-through, provider counter throws, generatedAt timestamp
 * - percentile: empty array, single value, p=100/p=0, nearest-rank on 10 values
 *
 * @see lib/orchestration/admin/live-engine-snapshot.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    aiWorkflowRunningStep: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/in-flight-counter', () => ({
  getInFlightCounts: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { getInFlightCounts } from '@/lib/orchestration/llm/in-flight-counter';
import { getLiveEngineSnapshot, percentile } from '@/lib/orchestration/admin/live-engine-snapshot';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Frozen system time used across all snapshot tests. */
const FROZEN_ISO = '2026-05-20T12:00:00.000Z';
const FROZEN_DATE = new Date(FROZEN_ISO);

/**
 * Build a minimal aggregate return value as Prisma would produce.
 * Passing null for createdAt simulates no pending rows.
 */
function makeQueuedAgg(count: number, oldestCreatedAt: Date | null) {
  return {
    _count: { _all: count },
    _min: { createdAt: oldestCreatedAt },
  };
}

/**
 * Build a running-step row for findMany.
 * startedAt is expressed as milliseconds before the frozen "now".
 */
function makeStepRow(executionId: string, ageMs: number) {
  return {
    executionId,
    startedAt: new Date(FROZEN_DATE.getTime() - ageMs),
  };
}

// ─── getLiveEngineSnapshot ────────────────────────────────────────────────────

describe('getLiveEngineSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_DATE);
    vi.clearAllMocks();

    // Safe defaults — empty system
    vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(0);
    vi.mocked(prisma.aiWorkflowExecution.aggregate).mockResolvedValue(
      makeQueuedAgg(0, null) as never
    );
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([]);
    vi.mocked(getInFlightCounts).mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 1. Empty system ─────────────────────────────────────────────────────────

  it('returns zero counts and null ages when nothing is running or queued', async () => {
    // Arrange: defaults above are already "empty system"

    // Act
    const snapshot = await getLiveEngineSnapshot();

    // Assert: all fields reflect the empty-system state
    expect(snapshot.running).toEqual({ count: 0, p95AgeMs: null, maxAgeMs: null });
    expect(snapshot.queued).toEqual({ count: 0, maxWaitMs: null });
    expect(snapshot.orphaned).toEqual({ count: 0 });
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.generatedAt).toBe(FROZEN_ISO);

    // The four Prisma reads must have fired (proves the parallel fan-out happened)
    expect(prisma.aiWorkflowExecution.count).toHaveBeenCalledTimes(2); // running + orphaned
    expect(prisma.aiWorkflowExecution.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.aiWorkflowRunningStep.findMany).toHaveBeenCalledTimes(1);
  });

  // ── 2. Single running step ───────────────────────────────────────────────────

  it('computes p95AgeMs and maxAgeMs from a single running-step row', async () => {
    // Arrange: one execution running, one step started 30 seconds ago
    vi.mocked(prisma.aiWorkflowExecution.count)
      .mockResolvedValueOnce(1) // runningCount
      .mockResolvedValueOnce(0); // orphanedCount
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
      makeStepRow('exec-1', 30_000),
    ] as never);

    // Act
    const snapshot = await getLiveEngineSnapshot();

    // Assert: degenerate single-sample — p95 and max are both the one value
    expect(snapshot.running.count).toBe(1);
    expect(snapshot.running.p95AgeMs).toBe(30_000);
    expect(snapshot.running.maxAgeMs).toBe(30_000);
  });

  // ── 3. Parallel fan-out: multiple branches per execution reduce to oldest ──

  it('reduces multiple branch rows for the same execution to the oldest start', async () => {
    // Arrange: two rows for the same execution — 10s and 60s old.
    // The 60s branch is the "stuck" one that should dominate.
    vi.mocked(prisma.aiWorkflowExecution.count)
      .mockResolvedValueOnce(1) // runningCount
      .mockResolvedValueOnce(0); // orphanedCount
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
      makeStepRow('exec-1', 10_000),
      makeStepRow('exec-1', 60_000),
    ] as never);

    // Act
    const snapshot = await getLiveEngineSnapshot();

    // Assert: only one unique execution; its age is the oldest branch (60s)
    expect(snapshot.running.count).toBe(1);
    expect(snapshot.running.maxAgeMs).toBe(60_000);
    expect(snapshot.running.p95AgeMs).toBe(60_000); // single reduced value
  });

  // ── 4. Mixed states ─────────────────────────────────────────────────────────

  it('populates all four cards correctly when running, queued, and orphaned coexist', async () => {
    // Arrange: 5 running, 3 step rows with ages [5s, 60s, 120s]; 2 queued (oldest 90s ago); 1 orphaned
    vi.mocked(prisma.aiWorkflowExecution.count)
      .mockResolvedValueOnce(5) // runningCount
      .mockResolvedValueOnce(1); // orphanedCount
    vi.mocked(prisma.aiWorkflowExecution.aggregate).mockResolvedValue(
      makeQueuedAgg(2, new Date(FROZEN_DATE.getTime() - 90_000)) as never
    );
    vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([
      makeStepRow('exec-a', 5_000),
      makeStepRow('exec-b', 60_000),
      makeStepRow('exec-c', 120_000),
    ] as never);

    // Act
    const snapshot = await getLiveEngineSnapshot();

    // Assert: running card
    expect(snapshot.running.count).toBe(5);
    expect(snapshot.running.maxAgeMs).toBe(120_000);
    // Nearest-rank p95 on [5000, 60000, 120000] — rank = ceil(0.95*3)=3, sorted[2]=120000
    expect(snapshot.running.p95AgeMs).toBe(120_000);

    // Assert: queued card
    expect(snapshot.queued.count).toBe(2);
    expect(snapshot.queued.maxWaitMs).toBe(90_000);

    // Assert: orphaned card
    expect(snapshot.orphaned.count).toBe(1);
  });

  // ── 5. Pending count 0 → maxWaitMs is null ──────────────────────────────────

  it('sets maxWaitMs to null when pending count is 0 and _min.createdAt is null', async () => {
    // Arrange: aggregate returns count=0 and createdAt=null
    vi.mocked(prisma.aiWorkflowExecution.aggregate).mockResolvedValue(
      makeQueuedAgg(0, null) as never
    );

    // Act
    const snapshot = await getLiveEngineSnapshot();

    // Assert: null is the correct signal ("no data"), not 0
    expect(snapshot.queued.count).toBe(0);
    expect(snapshot.queued.maxWaitMs).toBeNull();
  });

  // ── 6. Orphaned reported independently of running ────────────────────────────

  it('surfaces orphaned count independently without subtracting from running', async () => {
    // Arrange: 10 running, 3 orphaned (orphaned is a subset; we do not subtract)
    vi.mocked(prisma.aiWorkflowExecution.count)
      .mockResolvedValueOnce(10) // runningCount
      .mockResolvedValueOnce(3); // orphanedCount

    // Act
    const snapshot = await getLiveEngineSnapshot();

    // Assert: both counts appear as-is
    expect(snapshot.running.count).toBe(10);
    expect(snapshot.orphaned.count).toBe(3);
  });

  // ── 7. Provider snapshot pass-through ───────────────────────────────────────

  it('includes provider in-flight counts from getInFlightCounts in the snapshot', async () => {
    // Arrange: counter returns two providers
    vi.mocked(getInFlightCounts).mockReturnValue([
      { provider: 'anthropic', inFlight: 2 },
      { provider: 'openai', inFlight: 1 },
    ]);

    // Act
    const snapshot = await getLiveEngineSnapshot();

    // Assert: pass-through preserves the counter's output unchanged
    expect(snapshot.providers).toEqual([
      { provider: 'anthropic', inFlight: 2 },
      { provider: 'openai', inFlight: 1 },
    ]);
  });

  // ── 8. Provider counter throws → providers is empty array ───────────────────

  it('returns an empty providers array and keeps the rest of the snapshot intact when getInFlightCounts throws', async () => {
    // Arrange: one running execution so the snapshot is non-trivially populated
    vi.mocked(prisma.aiWorkflowExecution.count)
      .mockResolvedValueOnce(3) // runningCount
      .mockResolvedValueOnce(0); // orphanedCount
    vi.mocked(getInFlightCounts).mockImplementation(() => {
      throw new Error('in-flight counter unavailable');
    });

    // Act
    const snapshot = await getLiveEngineSnapshot();

    // Assert: providers degrades gracefully; running count is still correct
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.running.count).toBe(3);
  });

  // ── 9. generatedAt matches frozen system time ────────────────────────────────

  it('sets generatedAt to the ISO string of the frozen system time', async () => {
    // Arrange: clock is frozen to FROZEN_DATE (set in beforeEach)

    // Act
    const snapshot = await getLiveEngineSnapshot();

    // Assert: the string is the exact ISO representation of the frozen instant
    expect(snapshot.generatedAt).toBe(FROZEN_ISO);
  });
});

// ─── percentile ───────────────────────────────────────────────────────────────

describe('percentile', () => {
  it('returns null for an empty array', () => {
    expect(percentile([], 95)).toBeNull();
  });

  it('returns the single value for a one-element array at any positive p', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it('returns the maximum value when p is 100', () => {
    expect(percentile([1, 5, 3, 2, 4], 100)).toBe(5);
  });

  it('returns the minimum value when p is 0', () => {
    expect(percentile([1, 5, 3, 2, 4], 0)).toBe(1);
  });

  it('computes nearest-rank p95 correctly on a 10-element array', () => {
    // rank = ceil(0.95 * 10) = 10; sorted[9] = 10
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 95)).toBe(10);
  });

  it('computes nearest-rank p50 correctly on a 10-element array', () => {
    // rank = ceil(0.50 * 10) = 5; sorted[4] = 5
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
  });
});
