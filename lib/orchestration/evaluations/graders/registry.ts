/**
 * Grader registry — module-scoped map of slug → grader entry.
 *
 * Modelled on `lib/orchestration/engine/executor-registry.ts`: a flat
 * `Map<string, AnyGrader>` populated at startup by the barrel
 * (`./index.ts → registerBuiltInGraders()`). Adding a new grader is one
 * new file + one line in the barrel.
 *
 * Discoverability is the point of the registry: the run-creation UI
 * calls `listGraders()` to render the metric picker, and a parity test
 * asserts every slug in `KNOWN_GRADER_SLUGS` is registered at module
 * import — so a grader file that forgets to call `registerGrader`
 * fails CI rather than silently disappearing from the UI.
 *
 * Platform-agnostic — no Next.js, no DB.
 */

import type {
  AnyGrader,
  Grader,
  PairwiseGrader,
} from '@/lib/orchestration/evaluations/graders/types';

const registry = new Map<string, AnyGrader>();

/**
 * Register a grader. Re-registering overrides the previous entry —
 * useful in tests for swapping in mocks.
 */
export function registerGrader(grader: AnyGrader): void {
  registry.set(grader.slug, grader);
}

/**
 * Type-narrow lookup for single-output graders. Throws if the slug
 * isn't registered or names a pairwise grader (the worker's heuristic
 * + model dispatch paths must not silently fall through to pairwise).
 *
 * Returns `Grader<any>` so callers stay variance-friendly; the worker
 * parses config via `entry.configSchema` before invoking `entry.grade`,
 * so runtime safety is preserved at the call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getGrader(slug: string): Grader<any> {
  const entry = registry.get(slug);
  if (!entry) {
    throw new Error(`No grader registered for slug "${slug}"`);
  }
  if (entry.family === 'pairwise') {
    throw new Error(
      `Grader "${slug}" is pairwise; use getPairwiseGrader() for the two-output dispatch.`
    );
  }
  return entry;
}

/** Type-narrow lookup for pairwise graders. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPairwiseGrader(slug: string): PairwiseGrader<any> {
  const entry = registry.get(slug);
  if (!entry) {
    throw new Error(`No grader registered for slug "${slug}"`);
  }
  if (entry.family !== 'pairwise') {
    throw new Error(`Grader "${slug}" is not pairwise.`);
  }
  return entry;
}

/** Has-check used by run-creation validation before submission. */
export function hasGrader(slug: string): boolean {
  return registry.has(slug);
}

/**
 * List every registered grader. The order is registration order;
 * `registerBuiltInGraders` calls them in the order shown in the
 * metric picker UI.
 */
export function listGraders(): readonly AnyGrader[] {
  return Array.from(registry.values());
}

/** Inspect registered slugs — primarily for the parity test. */
export function getRegisteredSlugs(): readonly string[] {
  return Array.from(registry.keys());
}

/**
 * Reset the registry. Test-only helper — production code never calls
 * this.
 */
export function __resetGraderRegistryForTests(): void {
  registry.clear();
}
