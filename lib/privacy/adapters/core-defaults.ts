/**
 * Sunrise's own privacy adapters (§127) — the defaults every install starts
 * with, registered through the same registry an app uses.
 *
 * The three local detection tiers are here (t-989): rules, known values, and
 * word lists; the stateless token strategy (t-990); and the resolver that
 * applies an agent's mode and an org's minimum (t-1010). Each core adapter is
 * added here and nowhere else, so core's detectors are reached only through
 * the registry — `tests/unit/lib/privacy/pii/registry-only.test.ts` fails on
 * any other caller.
 *
 * Order matters within an egress: each detector is handed what the earlier
 * ones found, and tier C drops a guess that earlier spans already cover
 * entirely (every character of it masked already).
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
import { RULES_DETECTOR_ID, rulesDetector } from '@/lib/privacy/pii/rules';
import { statelessTokenStrategy } from '@/lib/privacy/pii/token-strategy';
import { scopeSettingsResolver } from '@/lib/orchestration/privacy/scope-settings';

/**
 * Tier A's id, for a caller that runs it alone through the runner
 * (`runPrivacyDetectors(text, { detectorIds: [...] })`): the output guard.
 * Here so nothing outside the registry imports the detector module.
 */
export const CORE_RULES_DETECTOR_ID = RULES_DETECTOR_ID;

/**
 * How long core's agent-and-org resolver may take: two primary-key reads,
 * but on the first call of a scope, so a cold or busy pool counts.
 */
export const SCOPE_SETTINGS_RESOLVER_TIMEOUT_MS = 5_000;

export interface CorePrivacyAdapters {
  /** Always registered as required: a core detector failing is a bug, and a bug refuses the call. */
  detectors: readonly { detector: PrivacyDetector; timeoutMs?: number }[];
  tokenStrategy: PrivacyTokenStrategy | null;
  policyResolvers: readonly { resolver: PrivacyPolicyResolver; timeoutMs?: number }[];
  observers: readonly PrivacyObserver[];
}

export function corePrivacyAdapters(): CorePrivacyAdapters {
  return {
    detectors: [
      { detector: rulesDetector() },
      { detector: knownValuesDetector() },
      { detector: listsDetector() },
    ],
    tokenStrategy: statelessTokenStrategy(),
    // The agent's mode and the org's minimum (t-1010). The install's own mode
    // is the base the stage starts from, so it needs no resolver.
    // Longer than the default: it reads the agent and the org from the
    // database, once per scope, and a resolver that times out refuses the
    // call, so a cold connection must not refuse a turn's first call.
    policyResolvers: [
      { resolver: scopeSettingsResolver(), timeoutMs: SCOPE_SETTINGS_RESOLVER_TIMEOUT_MS },
    ],
    observers: [],
  };
}
