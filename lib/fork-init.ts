/**
 * Fork init gates — run a fork's `initApp*` seam once, all-or-nothing.
 *
 * Eleven of the twelve `lib/app/*` seams are reached the same way: a core
 * registry runs the fork's init lazily, before its first read, so a fork can
 * accumulate registrations at module-import time without a startup hook. Ten of
 * them had hand-written a latch, a try/catch and a log line — four of those with
 * a rollback. The eleventh, `capabilities`, had only the latch, and it was set
 * AFTER the call.
 *
 * The twelfth, `initAppNav`, is not one of these and does not belong here: it is
 * called at module scope from a CLIENT component, because module registries do
 * not cross Next's bundle boundaries, so a throw fails the module's evaluation
 * and nothing reads the partial registry. `tests/unit/fork-init-seams.test.ts`
 * pins that exemption with its reason, so a new hand-rolled seam fails rather
 * than joining it.
 *
 * Hand-writing it went wrong in two ways that this module exists to make
 * impossible:
 *
 *  1. **Seven of the eleven kept the registrations a throwing init had already
 *     made** (#633). Six of those logged that the feature was disabled while
 *     doing it; the seventh, `capabilities`, did not catch at all. A fork author
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

/**
 * What the gate knows about the fork's init.
 *
 * **Three states, not two.** `'running'` is the one that is easy to forget and
 * expensive to get wrong: a fork init may re-enter the gate by calling one of
 * the registry's own public readers — the documented framework-tier bridge does
 * exactly that, and so does any `if (!getX().has(…))` de-dupe check. `ensure()`
 * returns `'running'` for those calls, because the init has neither succeeded
 * nor failed yet.
 *
 * This was a boolean, and both consumers that read it treated `false` as
 * "failed". The eight seams that ignore the value were unaffected; the two that
 * read it were both wrong, which is the signal that the type was the defect
 * rather than the callers. Collapsing `'running'` into `'failed'` cost Art. 15
 * subject access permanently on a *successful* init, and made the capability
 * registry manufacture a failure and blame the fork for it.
 */
export type AppInitState =
  /** The init is on the stack right now; this call re-entered the gate. */
  | 'running'
  /** The init ran and returned. */
  | 'ok'
  /** The init ran and threw; the registry was rolled back. */
  | 'failed';

/** A one-shot init gate over one fork seam. */
export interface AppInitGate {
  /**
   * Run the fork's init exactly once and report what the gate knows. Latched:
   * after the first run this returns the settled `'ok'` / `'failed'` verdict
   * without re-running anything. Never throws.
   */
  ensure(): AppInitState;
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
  /**
   * Runs after a failed init, once, with whatever was thrown — after the
   * rollback and the log line. For a registry whose consumer needs to do more
   * than degrade: `subject-source-registry` latches a flag that makes
   * `exportUserData()` refuse to build a bundle, and `capabilities/registry`
   * captures the error so it can re-raise rather than serve an agent whose
   * entire toolset silently vanished.
   *
   * Prefer this over reading `ensure()`'s verdict for "did it fail". The verdict
   * has three values, and `'running'` is not a failure — reading it as one is
   * what broke Art. 15 subject access on a successful init.
   *
   * A throw here is caught and logged rather than propagated — `ensure()` is
   * documented as never throwing and callers rely on that.
   */
  onFailure?: (err: unknown) => void;
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
  const { label, subject, init, snapshot, restore, onSuccess, onFailure } = options;
  let state: 'pending' | AppInitState = 'pending';

  return {
    ensure(): AppInitState {
      // Latched, and note this also covers re-entry: `state` moves off
      // `'pending'` BEFORE the init runs, so a read the init itself performs
      // returns `'running'` rather than starting a second one. A throwing init
      // must not retry on the next read either — for several of these
      // registries that is every chat turn or every maintenance tick.
      if (state !== 'pending') return state;
      state = 'running';

      const before = snapshot();
      try {
        init();
      } catch (err) {
        // Roll back, do not just log. See the module header: the registrations
        // an init made before it threw are otherwise live under a log line that
        // says the feature is off.
        restore(before);
        state = 'failed';
        logger.error(`${label} threw — ${subject} rolled back and disabled`, {
          error: describeThrown(err),
        });
        runCallback(label, 'onFailure', () => onFailure?.(err));
        return state;
      }

      state = 'ok';
      runCallback(label, 'onSuccess', () => onSuccess?.(before), 'the init itself succeeded');
      return state;
    },

    reset(): void {
      state = 'pending';
    },
  };
}

/**
 * Run one of the gate's optional callbacks without letting it escape.
 *
 * `ensure()` documents itself as never throwing, and it sits at the top of every
 * public read on eleven registries — several of which are separately documented
 * as always-safe-to-call. A callback that threw would break that contract after
 * the latch was already set, which is the same "the code does not do what its
 * own docblock says" shape this module exists to fix. So the claim is enforced
 * here rather than asserted in a comment.
 *
 * Logged rather than swallowed: the graders registry uses `onSuccess` to warn
 * that a fork replaced a built-in slug, and losing that silently would put an
 * admin back to reading scores changed by something nothing reported.
 */
function runCallback(label: string, hook: string, run: () => void, note?: string): void {
  try {
    run();
  } catch (err) {
    logger.error(`${label} — ${hook} threw${note ? `; ${note}` : ''}`, {
      error: describeThrown(err),
    });
  }
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
