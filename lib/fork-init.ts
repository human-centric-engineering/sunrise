/**
 * Fork init gates — run a fork's `initApp*` seam once, all-or-nothing.
 *
 * Every `lib/app/*` seam is reached the same way: a core registry runs the
 * fork's init lazily, before its first read, so a fork can accumulate
 * registrations at module-import time without a startup hook. Eleven registries
 * do this, and each one had hand-written the same four moving parts — a latch, a
 * try/catch, a log line, and (in four of them) a rollback.
 *
 * Hand-writing it went wrong in two ways that this module exists to make
 * impossible:
 *
 *  1. **Seven of the eleven kept the registrations a throwing init had already
 *     made**, while logging that the feature was disabled (#633). A fork author
 *     reading "app jobs disabled" has no reason to guard a multi-registration
 *     init — so a job registered before the throw ran on every maintenance tick
 *     from a config its author believed had not loaded.
 *  2. **The latch was written after the call in one of them**, so its own
 *     comment ("guarded so it isn't re-run on every dispatch") was false on
 *     exactly the path that mattered: a throwing init re-ran on every dispatch,
 *     forever.
 *
 * The gate owns both. `ensure()` latches BEFORE running, so a throwing init
 * neither retries nor is re-entered, and rolls the registry back to its
 * pre-init contents on a throw, so "disabled" is literally true.
 *
 * **All-or-nothing is the contract, not a nicety.** A partial apply is worse
 * than none: it is a config the fork's author cannot reason about ("some of
 * your registrations applied, we will not say which"), and it makes the failure
 * depend on the position of the bug in their init rather than on its nature.
 *
 * @see .context/architecture/fork-init-seams.md — the roster and the guarantee
 * @see CUSTOMIZATION.md §4 — the `lib/app/` surface a fork fills
 */

import { logger } from '@/lib/logging';

/** A one-shot init gate over one fork seam. */
export interface AppInitGate {
  /**
   * Run the fork's init exactly once. Returns whether it completed — `true` on
   * the run that succeeded and on every call after it, `false` on the run that
   * threw and on every call after that. Never throws.
   */
  ensure(): boolean;
  /** Test-only: re-arm the one-shot so each test starts from a known state. */
  reset(): void;
}

export interface AppInitGateOptions<S> {
  /**
   * `<registry>: <initFnName>`, e.g. `'app-jobs: initAppJobs'`. Prefixes the
   * error log, so it names both the registry that degraded and the fork
   * function to go and look at.
   */
  label: string;
  /**
   * What is lost when the init fails, e.g. `'app jobs'`. Completes the log line
   * as `<label> threw — <subject> rolled back and disabled`.
   */
  subject: string;
  /** The fork's seam. */
  init: () => void;
  /**
   * Capture the registry's contents. Called immediately before `init`, so it
   * must copy rather than alias — `() => new Map(registry)`, not
   * `() => registry`.
   */
  snapshot: () => S;
  /** Put the captured contents back. Called only when `init` throws. */
  restore: (snapshot: S) => void;
  /**
   * Runs after a successful init, with the same pre-init snapshot. For the one
   * registry that needs a before/after diff (a fork grader replacing a built-in
   * slug changes every score an admin reads while changing nothing they can
   * see, so it is named in the log).
   */
  onSuccess?: (snapshot: S) => void;
}

/**
 * Build the gate. Call once at module scope; the returned `ensure()` goes at the
 * top of every public read.
 *
 * ```ts
 * const appInit = createAppInitGate({
 *   label: 'app-jobs: initAppJobs',
 *   subject: 'app jobs',
 *   init: initAppJobs,
 *   snapshot: () => new Map(jobs),
 *   restore: (before) => restoreMap(jobs, before),
 * });
 * ```
 */
export function createAppInitGate<S>(options: AppInitGateOptions<S>): AppInitGate {
  const { label, subject, init, snapshot, restore, onSuccess } = options;
  let ran = false;
  let succeeded = false;

  return {
    ensure(): boolean {
      if (ran) return succeeded;
      // Latch BEFORE running. A throwing init must not retry on the next read
      // (which for several of these registries is every chat turn or every
      // maintenance tick), and must not be re-entered by a read the init itself
      // performs.
      ran = true;

      const before = snapshot();
      try {
        init();
      } catch (err) {
        // Roll back, do not just log. See the module header: the registrations
        // an init made before it threw are otherwise live under a log line that
        // says the feature is off.
        restore(before);
        logger.error(`${label} threw — ${subject} rolled back and disabled`, {
          error: describeThrown(err),
        });
        return false;
      }

      succeeded = true;
      onSuccess?.(before);
      return true;
    },

    reset(): void {
      ran = false;
      succeeded = false;
    },
  };
}

/**
 * Replace `target`'s contents with `snapshot`'s, in place.
 *
 * In place because the registry is a module-scoped `const` every reader already
 * closes over — reassigning it would leave those readers on the old map.
 */
export function restoreMap<K, V>(target: Map<K, V>, snapshot: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

/**
 * A log-safe description of whatever a seam threw.
 *
 * `String(err)` is the usual fallback and it can itself throw:
 * `String(Object.create(null))` raises "Cannot convert object to primitive
 * value". That would escape the catch *after* the rollback has already run, and
 * surface as an unexplained failure of the very thing the catch protects — a
 * fork's bad seam turned into a 500 with no log line saying why.
 */
export function describeThrown(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'a value that cannot be converted to a string';
  }
}
