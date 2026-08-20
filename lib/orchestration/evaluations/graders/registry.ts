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
 * A fork registers its own graders from `lib/app/evaluations.ts`, which
 * every reader below runs once before its first lookup (#541). The header
 * advertised pluggability that only held for core: `registerGrader` was
 * exported, but the only thing that called it was this package's own
 * barrel, and the batch worker runs in the route realm — so a grader
 * registered from `initApp()` filled a map the worker never read.
 *
 * Platform-agnostic — no Next.js, no DB.
 */

import { logger } from '@/lib/logging';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { initAppGraders } from '@/lib/app/evaluations';
import type {
  AnyGrader,
  Grader,
  PairwiseGrader,
} from '@/lib/orchestration/evaluations/graders/types';

const registry = new Map<string, AnyGrader>();

/**
 * Run the fork's auto-wired init exactly once, lazily, before the first lookup,
 * rolling a partial init back — see `lib/fork-init.ts` for the shared contract.
 * An init failure degrades to "no app graders", which surfaces as the ordinary
 * `No grader registered for slug` rather than as a crash halfway through a paid
 * drain.
 *
 * The before/after slug diff is why this one passes `onSuccess`. Overriding a
 * built-in slug is allowed — `registerGrader` has always overwritten, and
 * swapping in a mock is why — but a silently replaced `exact_match` changes
 * every score an admin reads while changing nothing they can see, so it is
 * named in the log.
 */
const appInit = createAppInitGate({
  label: 'graders: initAppGraders',
  // A rollback matters most here for the same reason the diff below does: if a
  // grader registered before the throw replaced `exact_match`, the
  // built-in-override warning never runs, so every score silently changes with
  // nothing anywhere saying so.
  subject: 'app graders',
  init: initAppGraders,
  snapshot: () => new Map(registry),
  restore: (before) => restoreMap(registry, before),
  onSuccess: (before) => {
    for (const [slug, grader] of before) {
      if (registry.get(slug) !== grader) {
        logger.warn('graders: an app grader replaced a built-in slug', { slug });
      }
    }
  },
});

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
  appInit.ensure();
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
  appInit.ensure();
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
  appInit.ensure();
  return registry.has(slug);
}

/**
 * List every registered grader. The order is registration order;
 * `registerBuiltInGraders` calls them in the order shown in the
 * metric picker UI.
 */
export function listGraders(): readonly AnyGrader[] {
  appInit.ensure();
  return Array.from(registry.values());
}

/** Inspect registered slugs — primarily for the parity test. */
export function getRegisteredSlugs(): readonly string[] {
  appInit.ensure();
  return Array.from(registry.keys());
}

/**
 * Reset the registry. Test-only helper — production code never calls
 * this.
 */
export function __resetGraderRegistryForTests(): void {
  registry.clear();
  appInit.reset();
}
