/**
 * Sunrise's own privacy adapters (§127) — the defaults every install starts
 * with, registered through the same registry an app uses.
 *
 * Empty until the tasks that build them land: the local detection tiers
 * (t-989), the stateless token strategy (t-990), and the settings-backed
 * policy resolver and metadata observer (t-991). Each adds its adapter here,
 * and nowhere else, so core's detectors are reached only through the registry.
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

export interface CorePrivacyAdapters {
  /** Always registered as required: a core detector failing is a bug, and a bug refuses the call. */
  detectors: readonly { detector: PrivacyDetector; timeoutMs?: number }[];
  tokenStrategy: PrivacyTokenStrategy | null;
  policyResolvers: readonly PrivacyPolicyResolver[];
  observers: readonly PrivacyObserver[];
}

export function corePrivacyAdapters(): CorePrivacyAdapters {
  return { detectors: [], tokenStrategy: null, policyResolvers: [], observers: [] };
}
