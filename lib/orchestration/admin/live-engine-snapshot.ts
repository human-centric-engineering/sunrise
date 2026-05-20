/**
 * Live-engine snapshot for the admin live-engine dashboard.
 *
 * Materialises the four numbers the page asks for in one call:
 *
 *  - running:   in-flight executions + age-of-current-step distribution
 *  - queued:    pending executions + max wait
 *  - orphaned:  running rows whose lease has expired (subset of running)
 *  - providers: in-flight call counts per provider slug (in-memory)
 *
 * Read-only and side-effect free. Designed to be polled every ~5s by
 * the admin page; query plan relies on existing indexes
 * (`AiWorkflowExecution[status, leaseExpiresAt]`, `[status, createdAt]`,
 * `AiWorkflowRunningStep[executionId]`).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getInFlightCounts } from '@/lib/orchestration/llm/in-flight-counter';
import { WorkflowStatus } from '@/types/orchestration';

export interface LiveEngineSnapshot {
  running: {
    count: number;
    p95AgeMs: number | null;
    maxAgeMs: number | null;
  };
  queued: {
    count: number;
    maxWaitMs: number | null;
  };
  orphaned: {
    count: number;
  };
  providers: { provider: string; inFlight: number }[];
  generatedAt: string;
}

/**
 * Hard cap on running rows we pull age data for. The dashboard only
 * needs distribution statistics, not per-row detail; if a deployment
 * has thousands of in-flight executions we'd rather degrade gracefully
 * (count is accurate; percentile is over a sample) than fan a multi-
 * thousand-row read at the 5s polling cadence.
 */
const RUNNING_AGE_SAMPLE_CAP = 500;

export async function getLiveEngineSnapshot(): Promise<LiveEngineSnapshot> {
  const now = new Date();

  // Four reads in parallel — each is small (count or capped page) and
  // hits an existing index. Provider counts come from in-memory state.
  const [runningCount, queuedAgg, orphanedCount, runningAges] = await Promise.all([
    prisma.aiWorkflowExecution.count({
      where: { status: WorkflowStatus.RUNNING },
    }),
    prisma.aiWorkflowExecution.aggregate({
      where: { status: WorkflowStatus.PENDING },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    prisma.aiWorkflowExecution.count({
      where: {
        status: WorkflowStatus.RUNNING,
        leaseExpiresAt: { lt: now },
      },
    }),
    // Age of each running execution's current step. Joined off the
    // `AiWorkflowRunningStep` side table (PR #202): for the same
    // execution we may have multiple branch rows (parallel fan-out);
    // we use MIN(startedAt) per execution so a long-running branch
    // dominates the age — that's the operator's "stuck" question.
    prisma.aiWorkflowRunningStep.findMany({
      where: { completedAt: null },
      select: { executionId: true, startedAt: true },
      orderBy: { startedAt: 'asc' },
      take: RUNNING_AGE_SAMPLE_CAP,
    }),
  ]);

  // Reduce per-branch rows to one age per execution: oldest start wins.
  const oldestPerExecution = new Map<string, number>();
  for (const row of runningAges) {
    const ageMs = now.getTime() - row.startedAt.getTime();
    const existing = oldestPerExecution.get(row.executionId);
    if (existing === undefined || ageMs > existing) {
      oldestPerExecution.set(row.executionId, ageMs);
    }
  }
  const ages = Array.from(oldestPerExecution.values());

  const queuedCount = queuedAgg._count._all;
  const oldestPending = queuedAgg._min.createdAt;

  return {
    running: {
      count: runningCount,
      p95AgeMs: percentile(ages, 95),
      maxAgeMs: ages.length > 0 ? Math.max(...ages) : null,
    },
    queued: {
      count: queuedCount,
      maxWaitMs: oldestPending ? now.getTime() - oldestPending.getTime() : null,
    },
    orphaned: {
      count: orphanedCount,
    },
    providers: safeProviderCounts(),
    generatedAt: now.toISOString(),
  };
}

/**
 * Defensive read of the in-flight counter. The counter is in-process
 * state with no failure modes today, but a future refactor could throw
 * — and a single bad call must never break the dashboard. If reading
 * fails we report an empty list (operators see "no provider activity"
 * which they can cross-check against the executions list).
 */
function safeProviderCounts(): { provider: string; inFlight: number }[] {
  try {
    return getInFlightCounts();
  } catch (err) {
    logger.warn('Live snapshot: provider counter read failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Nearest-rank percentile over a number array.
 * Returns null when the sample is empty so the dashboard can render
 * "no data" rather than `0` (which would lie about the absence).
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}
