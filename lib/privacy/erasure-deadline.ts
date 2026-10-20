/**
 * A time limit for one erasure attempt (t-845).
 *
 * An account deletion runs `eraseUser()` inside the request that asked for it.
 * On a host with a short request limit, a slow erasure used to be killed with
 * the request, and the person saw an error even though the retrier
 * (`processPendingErasures()`) would finish the job. With a deadline,
 * `eraseUser()` stops at the next safe point once time runs out and throws
 * {@link ErasureDeferredError}; the caller answers "pending" and the retrier
 * carries on from there.
 *
 * Each safe point sits between pieces of work that commit on their own: the
 * avatars, each hook, each pre-pass chunk or page, each try of the
 * transaction. A piece already running is capped at the time left, through
 * Postgres's `statement_timeout` and `lock_timeout` and Prisma's transaction
 * timeout, so it cannot run past the deadline either. Whatever committed
 * before the stop stays done, and the next attempt does only the rest, so
 * every deferral makes progress.
 *
 * @see lib/privacy/erase-user.ts — where the safe points are
 * @see lib/privacy/erasure-requests.ts — who sets the deadline
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { boundLockWaits } from '@/lib/privacy/erased-subjects';

/**
 * Thrown by `eraseUser()` when its deadline runs out before it finishes. What
 * committed before it stays done; nothing after it was started, and the
 * transaction that deletes the account rolled back if it was open. The
 * account still exists. Run the erasure again to finish it.
 */
export class ErasureDeferredError extends Error {
  constructor(
    /** Where the erasure stopped, for the log. */
    readonly stage: string,
    options?: { cause?: unknown }
  ) {
    super(`Erasure ran out of time before ${stage}`, options);
    this.name = 'ErasureDeferredError';
  }
}

/** Milliseconds left before `deadline`; never negative. */
export function msLeft(deadline: Date): number {
  return Math.max(0, deadline.getTime() - Date.now());
}

/** Throw {@link ErasureDeferredError} if `deadline` has passed. A no-op without one. */
export function checkDeadline(deadline: Date | undefined, stage: string): void {
  if (deadline && msLeft(deadline) <= 0) throw new ErasureDeferredError(stage);
}

/**
 * Run `fn` in a transaction of its own, capped at the time left before
 * `deadline` (and at `capMs`, when that is shorter). Throws
 * {@link ErasureDeferredError} without starting when no time is left, and in
 * place of a timeout `fn` hit once the deadline has passed (see
 * {@link deferredIfLate}).
 */
export async function inBoundedTransaction<T>(
  client: Pick<PrismaClient, '$transaction'>,
  deadline: Date,
  stage: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  capMs = Number.POSITIVE_INFINITY
): Promise<T> {
  checkDeadline(deadline, stage);
  const ms = Math.min(msLeft(deadline), capMs);
  try {
    return await client.$transaction(
      async (tx) => {
        // The time left now, not `ms`: Prisma starts its timeout once it has
        // a connection, so a wait for one would otherwise run past the deadline.
        await boundLockWaits(tx, Math.min(ms, msLeft(deadline)), { statementsToo: true });
        return fn(tx);
      },
      // Waiting for a connection counts against the deadline too.
      { timeout: ms, maxWait: Math.min(2_000, ms) }
    );
  } catch (error) {
    throw deferredIfLate(error, deadline, stage);
  }
}

/** Postgres's `query_canceled` (a `statement_timeout`) and `lock_not_available` (a `lock_timeout`). */
const TIMEOUT_SQLSTATES = new Set(['57014', '55P03']);

/**
 * Prisma's own time limits: a transaction past its timeout (P2028, which also
 * covers one that could not start within `maxWait`) and a connection-pool
 * wait (P2024).
 */
const TIMEOUT_PRISMA_CODES = new Set(['P2028', 'P2024']);

/** Where Prisma 7's pg adapter puts a raw query's Postgres SQLSTATE. */
const adapterErrorMetaSchema = z.object({
  driverAdapterError: z.object({ cause: z.object({ originalCode: z.string() }) }),
});

function sqlStateOf(meta: unknown): string | undefined {
  const parsed = adapterErrorMetaSchema.safeParse(meta);
  return parsed.success ? parsed.data.driverAdapterError.cause.originalCode : undefined;
}

/**
 * Whether `error` is one of the time limits a deadline sets: Postgres's
 * statement or lock timeout, or Prisma's transaction or pool timeout. Anything
 * else is a real failure, whenever it happens.
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (TIMEOUT_PRISMA_CODES.has(error.code)) return true;
    const sqlState = sqlStateOf(error.meta);
    if (sqlState !== undefined) return TIMEOUT_SQLSTATES.has(sqlState);
  }
  // Raised another way (a fork's hook, a test double): Postgres's own words.
  return (
    error instanceof Error &&
    /canceling statement due to (statement|lock) timeout/.test(error.message)
  );
}

/**
 * `error`, or an {@link ErasureDeferredError} in its place when `deadline`
 * has passed and `error` is a timeout: the deadline's cap is then what stopped
 * the work. Any other error is a failure, even after the deadline, so it is
 * logged as one and backed off.
 */
export function deferredIfLate(error: unknown, deadline: Date | undefined, stage: string): unknown {
  if (error instanceof ErasureDeferredError) return error;
  if (deadline && msLeft(deadline) <= 0 && isTimeoutError(error)) {
    return new ErasureDeferredError(stage, { cause: error });
  }
  return error;
}
