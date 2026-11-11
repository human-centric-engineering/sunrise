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
import {
  privacyPolicyPatchSchema,
  privacyPolicySchema,
  tightenPolicy,
} from '@/lib/privacy/adapters/policy';
import { getPrivacyAdapters } from '@/lib/privacy/adapters/registry';
import { MalformedSpansError, resolveOverlaps, validateSpans } from '@/lib/privacy/adapters/spans';
import type {
  AttributedSpan,
  DetectContext,
  EntityType,
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
  /**
   * The policy's ignored types. Their spans are dropped BEFORE overlaps are
   * merged, never after: a merged span takes one member's type, so filtering
   * afterwards would let an ignored `LOCATION` that overlaps an `ADDRESS`
   * carry the address out unmasked.
   */
  ignoredEntityTypes?: readonly EntityType[];
  /**
   * Run only the detectors with these ids, or that replaced a core detector
   * with one of them (`replace`), in registry order; all of them when absent.
   * The output guard runs just `core.rules` this way, so an app's replacement
   * of that detector changes what the guard flags too.
   */
  detectorIds?: readonly string[];
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
 *
 * Not `withTimeout()` from `lib/utils/with-timeout.ts`, deliberately. That one
 * keeps waiting after its cancel signal aborts, lets a synchronous throw
 * escape, and rejects with a plain `Error` a caller could only classify by its
 * message. Changing those would change the email sends that use it.
 */
async function raceAdapter<T>(
  fn: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined
): Promise<T> {
  // An abandoned call does not start the adapter at all.
  if (outer?.aborted) throw abortReason(outer);
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const listener = () => reject(abortReason(signal));
  signal.addEventListener('abort', listener, { once: true });
  const timer = setTimeout(() => controller.abort(new AdapterTimeoutError()), timeoutMs);
  // `.then` so a synchronous throw inside `fn` becomes a rejection here too.
  const work = Promise.resolve().then(() => fn(signal));
  work.catch(() => undefined);
  aborted.catch(() => undefined);
  try {
    return await Promise.race([work, aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', listener);
  }
}

/** The abort reason as an Error; a caller may abort with anything. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
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
 * remaining detectors are reported `aborted` without being run. Each
 * detector's timeout bounds that detector only: the caller bounds the whole
 * pass by passing a deadline as `ctx.signal` (`AbortSignal.timeout()`).
 */
export async function runPrivacyDetectors(
  text: string,
  ctx: DetectionCallContext
): Promise<DetectionResult> {
  const { detectors: registered } = getPrivacyAdapters();
  const only = ctx.detectorIds ? new Set(ctx.detectorIds) : null;
  const detectors = only
    ? registered.filter(
        (r) => only.has(r.id) || (r.replacesCore !== undefined && only.has(r.replacesCore))
      )
    : registered;
  const rank = new Map(detectors.map((r, i) => [r.id, i]));
  const found: AttributedSpan[] = [];
  const failures: AdapterFailure[] = [];
  const { signal: outer, ignoredEntityTypes = [], detectorIds: _only, ...rest } = ctx;
  // Frozen once: every detector sees the same known values, and none can
  // change what a later one (or the caller) reads.
  const callCtx = {
    ...rest,
    knownValues: Object.freeze(rest.knownValues.map((v) => Object.freeze({ ...v }))),
  };
  // An external detector is another processor. It is sent the text it must
  // scan and nothing more: known values may not appear in the text at all, so
  // handing them over would disclose more than the call itself does.
  const externalCtx = { ...callCtx, knownValues: Object.freeze([]) };

  for (const registration of detectors) {
    const { detector, id, egress, required, timeoutMs, entityTypes } = registration;
    const base = egress === 'external' ? externalCtx : callCtx;
    if (outer?.aborted) {
      failures.push({ adapterId: id, required, reason: 'aborted' });
      continue;
    }
    try {
      // The spans are frozen by validateSpans; the array is frozen here.
      const priorSpans = Object.freeze([...found]);
      const result = await raceAdapter(
        (signal) => detector.detect({ text }, { ...base, signal, priorSpans }),
        timeoutMs,
        outer
      );
      found.push(...validateSpans(result, text, id, new Set(entityTypes)));
    } catch (err) {
      const reason = classify(err, outer);
      failures.push({ adapterId: id, required, reason });
      logger.warn('privacy-adapters: detector failed', {
        adapterId: id,
        required,
        reason,
        errorName: errorName(err),
        ...(err instanceof MalformedSpansError ? { detail: err.reason } : {}),
      });
    }
  }

  const ignored = new Set(ignoredEntityTypes);
  const acted = found.filter((s) => !ignored.has(s.type));
  return { spans: resolveOverlaps(acted, rank), failures };
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
 * A resolver that returns `undefined` or `null` changes nothing; one that
 * returns anything else that is not a policy is a failure.
 */
export async function resolvePrivacyPolicy(
  base: PrivacyPolicy,
  input: PolicyInput,
  signal?: AbortSignal
): Promise<PolicyResult> {
  const { policyResolvers } = getPrivacyAdapters();
  // The base comes from settings, which the stage reads and is responsible
  // for. An invalid one is a bug, and a bug refuses: an unknown mode would
  // otherwise rank as looser than `off`.
  const checked = privacyPolicySchema.safeParse(base);
  if (!checked.success)
    throw new Error('resolvePrivacyPolicy: the base policy is not a valid policy');
  let policy: PrivacyPolicy = checked.data;
  const failures: AdapterFailure[] = [];
  const frozenInput = Object.freeze({ ...input });
  for (const { resolver, id, timeoutMs } of policyResolvers) {
    try {
      // A copy, frozen: the policy so far is the thing a resolver must not be
      // able to loosen, and mutating the object it was handed would do that.
      const current = Object.freeze({
        ...policy,
        ignoredEntityTypes: Object.freeze([...policy.ignoredEntityTypes]),
      });
      const patch: unknown = await raceAdapter(
        (adapterSignal) => resolver.resolve(frozenInput, current, { signal: adapterSignal }),
        timeoutMs,
        signal
      );
      // "No change", however a fork's resolver happens to spell it.
      if (patch === undefined || patch === null) continue;
      const parsed = privacyPolicyPatchSchema.safeParse(patch);
      if (!parsed.success) {
        failures.push({ adapterId: id, required: true, reason: 'malformed' });
        logger.warn('privacy-adapters: policy resolver returned a value that is not a policy', {
          adapterId: id,
        });
        continue;
      }
      policy = tightenPolicy(policy, parsed.data);
    } catch (err) {
      const reason = classify(err, signal);
      failures.push({ adapterId: id, required: true, reason });
      logger.warn('privacy-adapters: policy resolver failed', {
        adapterId: id,
        reason,
        errorName: errorName(err),
      });
    }
  }
  return { policy, failures };
}

/**
 * Tell every observer what happened. Fire-and-forget: an observer cannot
 * delay, change or fail the call, and its failure is logged and dropped. They
 * share one frozen copy, so none can alter what another receives.
 */
export function notifyPrivacyObservers(event: PrivacyEvent): void {
  const { observers } = getPrivacyAdapters();
  if (observers.length === 0) return;
  const copy = Object.freeze({
    ...event,
    counts: Object.freeze({ ...event.counts }),
    failedAdapters: Object.freeze([...event.failedAdapters]),
  });
  for (const { observer, id } of observers) {
    void Promise.resolve()
      .then(() => observer.observe(copy))
      .catch((err: unknown) => {
        logger.warn('privacy-adapters: observer failed', {
          adapterId: id,
          errorName: errorName(err),
        });
      });
  }
}
