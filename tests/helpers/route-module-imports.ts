/**
 * Importing every route module under `app/` in one hook, without timing out.
 *
 * Written for `tests/unit/app/layout-metadata.test.ts`, whose `beforeAll` imports
 * every `layout.tsx` / `page.tsx` to read the metadata Next would serve. It used
 * to await each import in turn against a fixed 120s hook timeout. Sunrise has 91
 * route modules; a fork with ~191 ran past the limit under coverage and the hook
 * aborted (#969). Because that file is in `ALWAYS_RUN_TESTS`, the abort took every
 * `test:changed:coverage` run in that fork down with it, on every branch.
 *
 * Two changes, and the second is the one that holds:
 *
 *   - **Bounded concurrency.** Overlapping imports lets one module's transform and
 *     file reads proceed while another evaluates. Measured on Sunrise under v8
 *     coverage with the module cache off, paired runs: limit 8 cut the hook by
 *     roughly 15–45% against limit 1. Real, but not a fix on its own: module
 *     evaluation is single-threaded, so the cost still grows with the count.
 *   - **A timeout that scales with the count.** A fixed limit is a cap on how many
 *     routes a fork may have. This one keeps the old 120s as a floor and grows by
 *     a per-module allowance past it.
 */

/** How many route-module imports run at once. See the measurement above. */
export const ROUTE_IMPORT_CONCURRENCY = 8;

/** The fixed limit the hook used to have; still the minimum. */
export const ROUTE_IMPORT_TIMEOUT_FLOOR_MS = 120_000;

/**
 * Per-module allowance. Sunrise's worst measured cold run was ~140ms a module;
 * this is about ten times that, a little more than the ~1.3s a module the old
 * 120s gave Sunrise's 91 — headroom that still ran out in a contended CI run.
 */
export const ROUTE_IMPORT_MS_PER_MODULE = 1_500;

/** Hook timeout for importing `count` route modules. */
export function routeImportTimeoutMs(count: number): number {
  return Math.max(ROUTE_IMPORT_TIMEOUT_FLOOR_MS, count * ROUTE_IMPORT_MS_PER_MODULE);
}

/**
 * Map over a list with at most `limit` calls in flight, results in input order.
 *
 * FAILS LIKE `Promise.all`: the first rejection rejects the whole call, and no
 * further items are started. The metadata test is a brand-leak guard, and an
 * import that is quietly skipped would let it pass while checking less. Do not
 * add a catch here or at the call site.
 *
 * Unlike `Promise.all`, it rejects only once the calls already in flight have
 * settled, so no import is still evaluating after the hook has been reported as
 * failed. The error is the first one; later ones are dropped.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}
