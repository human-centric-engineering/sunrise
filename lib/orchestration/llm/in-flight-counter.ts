/**
 * Per-provider in-flight call counter.
 *
 * Tracks how many LLM/embedding/transcribe calls are currently in
 * flight against each provider slug, surfaced on the admin live-engine
 * dashboard so operators can spot provider saturation independently of
 * the circuit breaker (which fires on *failures*, not concurrency).
 *
 * Scope: in-memory, per process. The live-engine page polls a single
 * process. In multi-process deployments each process owns its own
 * counts — operators reading the dashboard understand it as "this
 * worker's load" rather than a global tally. Persisting these would
 * cost a DB write per call for marginal benefit; the per-process view
 * is enough to answer "is this worker saturated?"
 *
 * Correctness contract: every `increment(slug)` MUST be paired with a
 * `decrement(slug)`. The `track()` helper is the only safe public API
 * — it wraps the increment/decrement pair in try/finally so an SDK
 * throw can never leak a count. Callers that need streaming semantics
 * should use `trackStream()` instead, which guarantees decrement once
 * the iterator settles (completes, throws, or is abandoned).
 */

const counts = new Map<string, number>();

function increment(slug: string): void {
  counts.set(slug, (counts.get(slug) ?? 0) + 1);
}

function decrement(slug: string): void {
  const next = (counts.get(slug) ?? 0) - 1;
  if (next <= 0) {
    counts.delete(slug);
  } else {
    counts.set(slug, next);
  }
}

/**
 * Wrap a single-shot async provider call so the in-flight count for
 * `slug` is incremented for the lifetime of the returned promise.
 *
 * `try/finally` is the whole point: the decrement must run whether the
 * SDK call resolves, rejects, or is abandoned by the caller.
 */
export async function track<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  increment(slug);
  try {
    return await fn();
  } finally {
    decrement(slug);
  }
}

/**
 * Wrap a streaming provider call (`AsyncIterable<T>`) so the in-flight
 * count for `slug` is held for the lifetime of the stream — from the
 * caller's first `next()` until the stream completes, throws, or the
 * caller breaks out early. Uses the iterator's `return()` hook so an
 * unconsumed `for await` `break` still releases the count.
 *
 * The original iterable is not exposed directly because relying on the
 * consumer to count `for await` completion would leak counts on early
 * exit. Wrapping the iterator gives us a single place to put the
 * decrement.
 */
export function trackStream<T>(slug: string, fn: () => AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      increment(slug);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        decrement(slug);
      };

      let iter: AsyncIterator<T>;
      try {
        const inner = fn();
        iter = inner[Symbol.asyncIterator]();
      } catch (err) {
        release();
        throw err;
      }

      return {
        async next(): Promise<IteratorResult<T>> {
          try {
            const result = await iter.next();
            if (result.done) release();
            return result;
          } catch (err) {
            release();
            throw err;
          }
        },
        async return(value?: T): Promise<IteratorResult<T>> {
          release();
          if (typeof iter.return === 'function') {
            return iter.return(value);
          }
          return { value: value as T, done: true };
        },
        async throw(err?: unknown): Promise<IteratorResult<T>> {
          release();
          if (typeof iter.throw === 'function') {
            return iter.throw(err);
          }
          throw err;
        },
      };
    },
  };
}

/**
 * Snapshot the current per-provider in-flight counts. Returns an array
 * sorted by descending count then alphabetical slug so the dashboard
 * is stable across polls. Empty array when nothing is in flight (the
 * map is pruned on zero).
 */
export function getInFlightCounts(): { provider: string; inFlight: number }[] {
  return Array.from(counts.entries())
    .map(([provider, inFlight]) => ({ provider, inFlight }))
    .sort((a, b) => {
      if (b.inFlight !== a.inFlight) return b.inFlight - a.inFlight;
      return a.provider.localeCompare(b.provider);
    });
}

/** Test helper — resets all counters. Never call from production paths. */
export function __resetInFlightCountersForTests(): void {
  counts.clear();
}
