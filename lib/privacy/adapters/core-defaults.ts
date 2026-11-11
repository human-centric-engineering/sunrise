/**
 * Sunrise's own privacy adapters (§127) — the defaults every install starts
 * with, registered through the same registry an app uses.
 *
 * The three local detection tiers are here (t-989): rules, known values, and
 * word lists. Still to come: the stateless token strategy (t-990), and the
 * settings-backed policy resolver and metadata observer (t-991). Each adds its
 * adapter here and nowhere else, so core's detectors are reached only through
 * the registry — `tests/unit/lib/privacy/pii/registry-only.test.ts` fails on
 * any other caller.
 *
 * Order matters within an egress: each detector is handed what the earlier
 * ones found, and tier C skips text tiers A and B already covered.
 *
 * Every core id starts with `core.`; the registry refuses that prefix from an
 * app, so an app can replace a core adapter only by naming it.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Adapters*
 */
import type {
  PrivacyDetector,
  PrivacyObserver,
  PrivacyPolicyResolver,
  PrivacyTokenStrategy,
} from '@/lib/privacy/adapters/types';
import { knownValuesDetector } from '@/lib/privacy/pii/known-values';
import { listsDetector } from '@/lib/privacy/pii/lists';
import { rulesDetector } from '@/lib/privacy/pii/rules';

export interface CorePrivacyAdapters {
  /** Always registered as required: a core detector failing is a bug, and a bug refuses the call. */
  detectors: readonly { detector: PrivacyDetector; timeoutMs?: number }[];
  tokenStrategy: PrivacyTokenStrategy | null;
  policyResolvers: readonly PrivacyPolicyResolver[];
  observers: readonly PrivacyObserver[];
}

export function corePrivacyAdapters(): CorePrivacyAdapters {
  return {
    detectors: [
      { detector: rulesDetector() },
      { detector: knownValuesDetector() },
      { detector: listsDetector() },
    ],
    tokenStrategy: null,
    policyResolvers: [],
    observers: [],
  };
}
