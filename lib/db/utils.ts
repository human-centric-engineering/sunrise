import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { runAsLivenessProbe } from '@/lib/tenancy/context';

/**
 * Database utility functions
 */

/**
 * Check if database connection is working
 *
 * Runs its `SELECT 1` in the liveness-probe scope, as `getDatabaseHealth()`
 * does and for the same reason: at `TENANCY_MODE=multi` the data layer refuses
 * raw SQL with no tenant context, so a caller with no org would be told the
 * database is down (#1262, t-1055).
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await runAsLivenessProbe(async () => {
      await prisma.$queryRaw`SELECT 1`;
    });
    return true;
  } catch (error) {
    logger.error('Database connection failed', error);
    return false;
  }
}

/**
 * Disconnect from database
 * Call this when shutting down the application
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Get database health status
 * Useful for health check endpoints
 *
 * The probe always enters the system scope (`runAsLivenessProbe`, logged at
 * debug), whatever its caller has entered. The unauthenticated `/api/health`
 * route has no org, and at `TENANCY_MODE=multi` the data layer refuses raw SQL
 * with no tenant context (#1262); the admin stats route leaves its org for the
 * probe. `SELECT 1` reads no rows, so the bypass reaches nothing. Run nothing
 * else inside it.
 */
export async function getDatabaseHealth(): Promise<{
  connected: boolean;
  latency?: number;
}> {
  const start = Date.now();

  try {
    await runAsLivenessProbe(async () => {
      await prisma.$queryRaw`SELECT 1`;
    });
    const latency = Date.now() - start;

    return {
      connected: true,
      latency,
    };
  } catch (error) {
    logger.error('Database health check failed', error);
    return {
      connected: false,
    };
  }
}

/**
 * Execute a database transaction
 * Wrapper for Prisma interactive transactions.
 *
 * Example:
 * ```ts
 * await executeTransaction(async (tx) => {
 *   await tx.user.create({ data: { ... } })
 *   await tx.post.create({ data: { ... } })
 * })
 * ```
 *
 * The optional `options` argument is forwarded verbatim to
 * `prisma.$transaction` and mirrors Prisma's interactive-transaction options:
 * - `timeout` — max ms the callback may run before the transaction expires
 *   (Prisma default: 5000)
 * - `maxWait` — max ms to wait for a connection from the pool
 *   (Prisma default: 2000)
 * - `isolationLevel` — transaction isolation level
 *
 * ```ts
 * await executeTransaction(work, { timeout: 20_000, maxWait: 10_000 })
 * ```
 *
 * Raising `timeout` buys headroom for genuinely heavy callbacks (e.g. a bulk
 * import where each round-trip to a remote/pooled Postgres costs 10–30 ms), but
 * it is a ceiling, not a fix. Prefer reducing round-trips first — batch with
 * `createMany` / `createManyAndReturn` in your own transaction code — and reach
 * for a higher `timeout` only when the work is irreducibly large.
 */
export async function executeTransaction<T>(
  callback: (
    tx: Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>
  ) => Promise<T>,
  options?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  }
): Promise<T> {
  return await prisma.$transaction(callback, options);
}
