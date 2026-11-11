/**
 * Running the privacy adapters for one call (§127).
 *
 * The registry decides WHAT runs; this decides HOW: each adapter under its own
 * timeout, enforced through its abort signal; its output validated before any
 * of it is used; its failure classified and reported. Nothing here decides
 * what a failure means for the call — that is the privacy stage's job, from
 * the policy — so every function returns what happened rather than acting on
 * it.
 *
 * Nothing here logs request text or a value an adapter found. A failure is
 * logged with the adapter's id, the reason and the error's class name only,
 * because an adapter's error message may quote what it was given.
 *
 * @see .context/privacy/llm-privacy-layer.md — *When an adapter fails*
 */
import { logger } from '@/lib/logging';
import { tightenPolicy, privacyPolicyPatchSchema } from '@/lib/privacy/adapters/policy';
import { getPrivacyAdapters, DEFAULT_DETECTOR_TIMEOUT_MS } from '@/lib/privacy/adapters/registry';
import { MalformedSpansError, resolveOverlaps, validateSpans } from '@/lib/privacy/adapters/spans';
import type {
  AttributedSpan,
  DetectContext,
  PolicyInput,
  PrivacyEvent,
  PrivacyPolicy,
} from '@/lib/privacy/adapters/types';

/** Why an adapter's contribution was lost. */
export type AdapterFailureReason = 'timeout' | 'threw' | 'malformed' | 'aborted';

export interface AdapterFailure {
  adapterId: string;
  /** Only detectors carry the flag; a policy resolver's failure is always fatal. */
  required: boolean;
  reason: AdapterFailureReason;
}

export interface DetectionResult {
  /** Validated, merged and sorted by start. */
  spans: AttributedSpan[];
  failures: AdapterFailure[];
}

/** What the caller supplies; the runner adds `signal` and `priorSpans` per adapter. */
export type DetectionCallContext = Omit<DetectContext, 'signal' | 'priorSpans'> & {
  /** Aborted when the whole call is abandoned. */
  signal?: AbortSignal;
};

class AdapterTimeoutError extends Error {
  constructor() {
    super('privacy adapter timed out');
    this.name = 'AdapterTimeoutError';
  }
}

/**
 * Run `fn` with a signal that aborts after `timeoutMs` or when `outer` aborts,
 * and settle as soon as either happens — an adapter that ignores its signal
 * cannot hold the call past its timeout. A late result is discarded, and a late
 * rejection is swallowed so it never becomes an unhandled rejection.
 */
async function withTimeout<T>(
  fn: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined
): Promise<T> {
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new AdapterTimeoutError());
      return;
    }
    onAbort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new AdapterTimeoutError());
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(new AdapterTimeoutError()), timeoutMs);
  });
  // `.then` so a synchronous throw inside `fn` becomes a rejection here too.
  const work = Promise.resolve().then(() => fn(signal));
  work.catch(() => undefined);
  aborted.catch(() => undefined);
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function classify(err: unknown, outer: AbortSignal | undefined): AdapterFailureReason {
  if (err instanceof MalformedSpansError) return 'malformed';
  if (outer?.aborted) return 'aborted';
  if (err instanceof AdapterTimeoutError) return 'timeout';
  return 'threw';
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Run every registered detector over `text`, in registry order, and merge
 * what they found.
 *
 * Detectors run one after another, not in parallel, because each is handed
 * what the earlier ones found (`priorSpans`) — that is what lets a service
 * adapter run only on what local checks flagged. Each gets its own timeout.
 *
 * A detector that times out, throws, or returns anything {@link validateSpans}
 * rejects contributes nothing, and is listed in `failures` with its
 * `required` flag. If the whole call is abandoned (`ctx.signal`), the
 * remaining detectors are reported `aborted` without being run.
 */
export async function runPrivacyDetectors(
  text: string,
  ctx: DetectionCallContext
): Promise<DetectionResult> {
  const { detectors } = getPrivacyAdapters();
  const rank = new Map(detectors.map((r, i) => [r.detector.id, i]));
  const found: AttributedSpan[] = [];
  const failures: AdapterFailure[] = [];
  const { signal: outer, ...rest } = ctx;
  // Frozen once: every detector sees the same known values, and none can
  // change what a later one (or the caller) reads.
  const callCtx = {
    ...rest,
    knownValues: Object.freeze(rest.knownValues.map((v) => Object.freeze({ ...v }))),
  };

  for (const registration of detectors) {
    const { detector, required, timeoutMs, entityTypes } = registration;
    if (outer?.aborted) {
      failures.push({ adapterId: detector.id, required, reason: 'aborted' });
      continue;
    }
    try {
      const priorSpans = Object.freeze(found.map((s) => Object.freeze({ ...s })));
      const result = await withTimeout(
        (signal) => detector.detect({ text }, { ...callCtx, signal, priorSpans }),
        timeoutMs,
        outer
      );
      found.push(...validateSpans(result, text, detector.id, entityTypes));
    } catch (err) {
      const reason = classify(err, outer);
      failures.push({ adapterId: detector.id, required, reason });
      logger.warn('privacy-adapters: detector failed', {
        adapterId: detector.id,
        required,
        reason,
        errorName: errorName(err),
        ...(err instanceof MalformedSpansError ? { detail: err.reason } : {}),
      });
    }
  }

  return { spans: resolveOverlaps(found, rank), failures };
}

export interface PolicyResult {
  policy: PrivacyPolicy;
  /**
   * Resolvers that threw, timed out or returned something that is not a
   * policy. A failed resolver might have tightened the policy, so the caller
   * cannot treat `policy` as complete while this is non-empty.
   */
  failures: AdapterFailure[];
}

/**
 * Apply every registered policy resolver to `base`, in registration order.
 * Each sees the policy so far and can only tighten it ({@link tightenPolicy}).
 */
export async function resolvePrivacyPolicy(
  base: PrivacyPolicy,
  input: PolicyInput,
  signal?: AbortSignal
): Promise<PolicyResult> {
  const { policyResolvers } = getPrivacyAdapters();
  let policy = base;
  const failures: AdapterFailure[] = [];
  const frozenInput = Object.freeze({ ...input });
  for (const resolver of policyResolvers) {
    try {
      // A copy, frozen: the policy so far is the thing a resolver must not be
      // able to loosen, and mutating the object it was handed would do that.
      const current = Object.freeze({
        ...policy,
        ignoredEntityTypes: Object.freeze([...policy.ignoredEntityTypes]),
      });
      const patch: unknown = await withTimeout(
        () => resolver.resolve(frozenInput, current),
        DEFAULT_DETECTOR_TIMEOUT_MS,
        signal
      );
      const parsed = privacyPolicyPatchSchema.safeParse(patch);
      if (!parsed.success) {
        failures.push({ adapterId: resolver.id, required: true, reason: 'malformed' });
        logger.warn('privacy-adapters: policy resolver returned a value that is not a policy', {
          adapterId: resolver.id,
        });
        continue;
      }
      policy = tightenPolicy(policy, parsed.data);
    } catch (err) {
      const reason = classify(err, signal);
      failures.push({ adapterId: resolver.id, required: true, reason });
      logger.warn('privacy-adapters: policy resolver failed', {
        adapterId: resolver.id,
        reason,
        errorName: errorName(err),
      });
    }
  }
  return { policy, failures };
}

/**
 * Tell every observer what happened. Fire-and-forget: an observer cannot
 * delay, change or fail the call, and its failure is logged and dropped. Each
 * gets its own frozen copy, so one cannot alter what the next receives.
 */
export function notifyPrivacyObservers(event: PrivacyEvent): void {
  const { observers } = getPrivacyAdapters();
  for (const observer of observers) {
    const copy = Object.freeze({
      ...event,
      counts: Object.freeze({ ...event.counts }),
      failedAdapters: Object.freeze([...event.failedAdapters]),
    });
    void Promise.resolve()
      .then(() => observer.observe(copy))
      .catch((err: unknown) => {
        logger.warn('privacy-adapters: observer failed', {
          adapterId: observer.id,
          errorName: errorName(err),
        });
      });
  }
}
