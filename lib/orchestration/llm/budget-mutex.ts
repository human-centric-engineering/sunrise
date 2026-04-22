/**
 * In-Process Per-Agent Budget Mutex
 *
 * Single-instance deployment guarantee: one Node.js process handles all
 * requests, so an in-memory Map is sufficient to serialize budget reads
 * and cost writes per agent. This prevents the TOCTOU race where two
 * concurrent requests both pass checkBudget() and then both log costs,
 * causing a temporary over-run.
 *
 * Accepted tolerance: concurrent requests from *different* agents proceed
 * in parallel (no global lock). Over-run is bounded to one LLM turn per
 * concurrent request for the same agent — typically < $0.01.
 */

const locks = new Map<string, Promise<void>>();

/**
 * Run `fn` under an exclusive per-agentId lock.
 * The lock serialises calls for the same agentId but not across agents.
 *
 * Uses promise chaining: each new caller's lock promise is set in the
 * map *before* awaiting the previous one, so a third caller sees the
 * second caller's promise (not the first's).
 */
export async function withAgentBudgetLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(agentId);

  let resolve!: () => void;
  const lock = new Promise<void>((r) => {
    resolve = r;
  });
  // Register our lock before awaiting — so the next caller chains behind us
  locks.set(agentId, lock);

  if (previous) await previous;

  try {
    return await fn();
  } finally {
    resolve();
    if (locks.get(agentId) === lock) {
      locks.delete(agentId);
    }
  }
}

/** Visible for testing only — wipes the lock map between tests. */
export function __resetLocksForTesting(): void {
  locks.clear();
}
