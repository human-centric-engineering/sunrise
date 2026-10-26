/**
 * Model parameters an agent or an `llm_call` step stores beyond
 * temperature / max tokens / reasoning effort, turned into `LlmOptions`.
 *
 * Kept apart from `model-heuristics` (which decides what each model accepts)
 * so a test that mocks that module whole still gets these.
 */

import {
  MAX_STOP_SEQUENCES,
  SERVICE_TIERS,
  VERBOSITIES,
  type LlmOptions,
  type ServiceTier,
  type Verbosity,
} from '@/lib/orchestration/llm/types';

/**
 * Narrow a stored value (plain `TEXT` column, or a bundle from a fork) to a
 * {@link Verbosity}, or `undefined`. Same reason as `narrowReasoningEffort`.
 */
export function narrowVerbosity(raw: string | null | undefined): Verbosity | undefined {
  return VERBOSITIES.find((value) => value === raw);
}

/** Narrow a stored value to a {@link ServiceTier}, or `undefined`. */
export function narrowServiceTier(raw: string | null | undefined): ServiceTier | undefined {
  return SERVICE_TIERS.find((value) => value === raw);
}

/** The stored model parameters `modelParamOptions` reads. */
export interface StoredModelParams {
  stopSequences?: readonly string[] | null;
  topP?: number | null;
  verbosity?: string | null;
  parallelToolCalls?: boolean | null;
  serviceTier?: string | null;
}

/**
 * The `LlmOptions` an agent row or an `llm_call` step config asks for,
 * narrowed (a stored value can come from raw SQL or a fork's bundle) and
 * with unset values left out, so the provider default applies. Whether a
 * model takes each one is the provider class's call, not this one's.
 */
export function modelParamOptions(
  stored: StoredModelParams
): Pick<LlmOptions, 'stopSequences' | 'topP' | 'verbosity' | 'parallelToolCalls' | 'serviceTier'> {
  const verbosity = narrowVerbosity(stored.verbosity);
  const serviceTier = narrowServiceTier(stored.serviceTier);
  const stopSequences = (stored.stopSequences ?? [])
    // Blank or whitespace-only sequences are refused by Anthropic.
    .filter((stop) => stop.trim().length > 0)
    .slice(0, MAX_STOP_SEQUENCES);
  return {
    ...(stopSequences.length > 0 ? { stopSequences } : {}),
    ...(typeof stored.topP === 'number' ? { topP: stored.topP } : {}),
    ...(verbosity !== undefined ? { verbosity } : {}),
    ...(typeof stored.parallelToolCalls === 'boolean'
      ? { parallelToolCalls: stored.parallelToolCalls }
      : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
  };
}
