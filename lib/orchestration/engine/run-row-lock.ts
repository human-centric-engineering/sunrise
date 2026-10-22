/**
 * Reading and writing a run under its row lock (§122 t-901).
 *
 * An action on a run — approve, reject, retry-step — reads the run's trace,
 * changes it, and writes it back whole. Read before an erasure and written
 * after it, the trace puts the erased person back, and a terminal run is never
 * scrubbed again. So the action takes the run's row lock (`FOR NO KEY UPDATE`)
 * first and reads inside it. Erasure locks each run it redacts the same way
 * (`lib/privacy/run-recipients.ts`), so the two are ordered: either the action
 * reads a run erasure already scrubbed, or erasure waits and reads what the
 * action wrote. A write that commits while an erasure is open, to a run its
 * pass had not reached, is caught by the pass erasure makes after it commits
 * (`redactSubjectFromRunsSince`, which reads every run written since).
 *
 * The lock is `FOR NO KEY UPDATE`, as erasure's and the engine's writes take:
 * it does not block foreign-key checks from rows that reference the run.
 *
 * @see lib/privacy/stale-writers.ts — the `row-lock` anchor
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { WRITER_TRANSACTION_OPTIONS } from '@/lib/privacy/erased-subjects';

/**
 * How a locked action on a run waits: an erasure may hold the row for its
 * whole transaction (60 s), and Prisma's 5 s default would fail the action
 * behind it; and for a connection, as a plain query does. The engine's own run
 * writes wait the same way (`RUN_WRITE_TRANSACTION_OPTIONS`).
 */
export const RUN_ROW_WRITE_OPTIONS = { ...WRITER_TRANSACTION_OPTIONS, maxWait: 10_000 } as const;

/** Take the run's row lock for the rest of `tx`. A missing run takes nothing. */
export async function lockRunRow(tx: Prisma.TransactionClient, executionId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM ai_workflow_execution WHERE id = ${executionId} FOR NO KEY UPDATE`;
}

/**
 * Run `fn` in a transaction that holds the run's row lock from the start, so
 * every read of the run inside it sees what an erasure that held the row left.
 */
export function withRunRowLocked<T>(
  executionId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockRunRow(tx, executionId);
    return fn(tx);
  }, RUN_ROW_WRITE_OPTIONS);
}
