/**
 * Shared resolver for the optional independent "judge" model used by
 * evaluation scoring and the `supervisor` workflow step.
 *
 * **Resolution order** (from highest to lowest priority):
 *
 *   1. Explicit `EVALUATION_JUDGE_PROVIDER` / `EVALUATION_JUDGE_MODEL`
 *      env vars (use a different, stronger model than the workflow's
 *      primary chat model — the canonical "judge ≥ subject" setup).
 *   2. `EVALUATION_DEFAULT_PROVIDER` / `EVALUATION_DEFAULT_MODEL` env
 *      vars (a single eval-default shared by judge + orphan-agent
 *      fallback).
 *   3. **`null`** — no explicit configuration. The caller MUST fall
 *      through to the system's configured chat default (the same path
 *      every other LLM step in the orchestration takes:
 *      `resolveAgentProviderAndModel` or `runLlmCall`'s default).
 *
 * The previous version hard-coded `'anthropic'` / `'claude-sonnet-4-6'`
 * as the lowest tier. That broke any deployment that didn't have an
 * Anthropic provider configured — the supervisor / evaluation scorer
 * would unconditionally try to reach Anthropic and fail with
 * `Provider "anthropic" unavailable`. Treat the env vars as optional
 * tuning knobs, not load-bearing config.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { formatModelPin, parseModelPin } from '@/lib/orchestration/llm/model-pin';

const env = (key: string): string | null => {
  const value = process.env[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const EVALUATION_DEFAULT_PROVIDER: string | null = env('EVALUATION_DEFAULT_PROVIDER');
export const EVALUATION_DEFAULT_MODEL: string | null = env('EVALUATION_DEFAULT_MODEL');

export const JUDGE_PROVIDER: string | null =
  env('EVALUATION_JUDGE_PROVIDER') ?? EVALUATION_DEFAULT_PROVIDER;
export const JUDGE_MODEL: string | null = env('EVALUATION_JUDGE_MODEL') ?? EVALUATION_DEFAULT_MODEL;

/**
 * The judge as a model pin (§136 t-1068), for a caller that hands it to
 * `runLlmCall` or resolves it as a step override would: `provider::model`
 * when a provider is configured with the model, so the judge runs on that
 * provider and not on whichever one the model registry gives the id. `null`
 * when no judge model is configured.
 */
export const JUDGE_MODEL_PIN: string | null =
  JUDGE_MODEL === null
    ? null
    : JUDGE_PROVIDER !== null && parseModelPin(JUDGE_MODEL)?.providerSlug === null
      ? formatModelPin(JUDGE_PROVIDER, JUDGE_MODEL)
      : JUDGE_MODEL;
