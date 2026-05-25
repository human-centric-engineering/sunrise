/**
 * Run lease helpers.
 *
 * Mirrors the lease/orphan-claim semantics used by
 * `processOrphanedExecutions` in lib/orchestration/scheduling. The
 * worker calls `claimNextRun()` at the start of every tick; the call
 * succeeds only when there's a queued run AND no other worker already
 * holds its lease. Stuck runs whose `lockedAt` is older than the
 * orphan threshold are eligible for re-claim.
 *
 * No transactions across multiple statements — the claim is a single
 * conditional UPDATE so two concurrent workers cannot both hold the
 * same lease.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Lease TTL. Runs whose `lockedAt` is older than this are considered
 * orphaned (the previous worker crashed mid-batch) and may be re-
 * claimed. Mirrors the workflow-orphan threshold.
 */
export const RUN_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * A snapshot of the row the worker needs to drive one tick. We narrow
 * the select to keep the worker self-contained; full row writes use
 * named updates against `id` directly.
 */
export interface ClaimedRun {
  id: string;
  userId: string;
  name: string;
  subjectKind: string;
  agentId: string | null;
  workflowId: string | null;
  datasetId: string;
  datasetContentHash: string;
  metricConfigs: unknown;
  judgeProvider: string | null;
  judgeModel: string | null;
  subjectOutputSelector: unknown;
  progress: unknown;
  parentRunId: string | null;
  status: string;
  startedAt: Date | null;
}

/**
 * Atomically claim the oldest queued (or orphaned-running) run.
 * Returns null when nothing is claimable. The caller MUST release the
 * lease (`releaseLease`) or transition the row to terminal status
 * before its tick ends.
 */
export async function claimNextRun(workerId: string): Promise<ClaimedRun | null> {
  const orphanCutoff = new Date(Date.now() - RUN_LEASE_TTL_MS);

  // Two-step claim:
  //  1. Find a candidate id (queued, OR running with released lease, OR
  //     running with stale lease — orphaned).
  //  2. CAS-update only if it still satisfies the predicate.
  // Postgres-portable; mirrors `processOrphanedExecutions`.
  //
  // The middle case (running + lockedBy=null) covers the worker's
  // intentional time-budget release: a partial run releases its lease
  // and the very next tick MUST be able to pick it up — waiting the full
  // 5-minute orphan window would stall long batches needlessly.
  const candidate = await prisma.aiEvaluationRun.findFirst({
    where: {
      OR: [
        { status: 'queued', lockedBy: null },
        { status: 'running', lockedBy: null },
        { status: 'running', lockedAt: { lt: orphanCutoff } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, lockedAt: true },
  });
  if (!candidate) return null;

  const now = new Date();
  const result = await prisma.aiEvaluationRun.updateMany({
    where: {
      id: candidate.id,
      OR: [
        { status: 'queued', lockedBy: null },
        { status: 'running', lockedBy: null },
        { status: 'running', lockedAt: { lt: orphanCutoff } },
      ],
    },
    data: {
      status: 'running',
      lockedBy: workerId,
      lockedAt: now,
    },
  });
  if (result.count === 0) {
    // Another worker won the race. Caller can try again next tick.
    return null;
  }

  // Stamp startedAt only on the first successful claim — resumed
  // (released-and-reclaimed) runs keep their original start time.
  await prisma.aiEvaluationRun.updateMany({
    where: { id: candidate.id, startedAt: null },
    data: { startedAt: now },
  });

  const claimed = await prisma.aiEvaluationRun.findUnique({
    where: { id: candidate.id },
    select: {
      id: true,
      userId: true,
      name: true,
      subjectKind: true,
      agentId: true,
      workflowId: true,
      datasetId: true,
      datasetContentHash: true,
      metricConfigs: true,
      judgeProvider: true,
      judgeModel: true,
      subjectOutputSelector: true,
      progress: true,
      parentRunId: true,
      status: true,
      startedAt: true,
    },
  });
  if (!claimed) {
    // Vanishingly rare — the row was deleted between updateMany and findUnique.
    logger.warn('Claimed evaluation run disappeared before read', { runId: candidate.id });
    return null;
  }
  return claimed;
}

/**
 * Release the lease so the next tick can resume this run. Guarded by
 * `status: 'running'` so a concurrent cancel (which sets `status='cancelled'`
 * and clears the lease itself) is never re-stamped by the lease holder.
 */
export async function releaseLease(runId: string): Promise<void> {
  await prisma.aiEvaluationRun.updateMany({
    where: { id: runId, status: 'running' },
    data: { lockedBy: null, lockedAt: null },
  });
}

/**
 * Mark the run terminal — status='completed'|'failed'|'cancelled'.
 *
 * Guarded by `status: 'running'`: if a concurrent cancel has already
 * transitioned the row to `'cancelled'` (or any other terminal status),
 * this is a no-op and returns `false`. Returns `true` when the row was
 * actually updated. The cancellation-by-admin path always wins against a
 * still-draining worker tick.
 */
export async function markTerminal(
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
  patch: { summary?: unknown; totalCostUsd?: number } = {}
): Promise<boolean> {
  const data: {
    status: typeof status;
    lockedBy: null;
    lockedAt: null;
    completedAt: Date;
    summary?: unknown;
    totalCostUsd?: number;
  } = {
    status,
    lockedBy: null,
    lockedAt: null,
    completedAt: new Date(),
  };
  if (patch.summary !== undefined) data.summary = patch.summary;
  if (patch.totalCostUsd !== undefined) data.totalCostUsd = patch.totalCostUsd;
  const result = await prisma.aiEvaluationRun.updateMany({
    where: { id: runId, status: 'running' },
    // The `data` map carries an arbitrary JSON `summary` that Prisma
    // types as a `JsonValue`; the cast is the documented escape hatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    data: data as any,
  });
  return result.count > 0;
}
