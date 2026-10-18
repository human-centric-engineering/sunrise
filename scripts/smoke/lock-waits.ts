/**
 * Helpers for smoke scripts that stage a race against real Postgres: hold a
 * row, see who queues behind it, then let go.
 *
 * Used by `erasure-stale-writers.ts` and `erasure-long-import.ts`.
 */

import { prisma } from '@/lib/db/client';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Sessions in this database waiting on a lock right now. */
export async function lockWaiters(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return row.n;
}

/** Poll `done` every 50 ms until it holds; throw after `ms`. */
export async function until(
  done: () => Promise<boolean> | boolean,
  ms: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/**
 * Hold `FOR UPDATE` on one workflow row until `release()` is called. Anything
 * that inserts a row pointing at the workflow (a run, a version) stalls on
 * its foreign-key check until then. `release()` is safe to call more than
 * once, so a script's `finally` can always call it.
 */
export function holdWorkflowRow(
  workflowId: string,
  timeoutMs: number
): { held: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM ai_workflow WHERE id = ${workflowId} FOR UPDATE`;
      await released;
    },
    { timeout: timeoutMs }
  );
  // A failure surfaces where the script awaits `held`; never unhandled.
  held.catch(() => undefined);
  return { held, release };
}
