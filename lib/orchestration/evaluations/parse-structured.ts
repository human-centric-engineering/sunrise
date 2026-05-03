/**
 * Structured-output runner for evaluation LLM calls.
 *
 * Wraps the call → parse → retry-once-on-malformed-JSON pattern that the
 * evaluation summary handler and the metric scorer both need. Keeping the
 * retry policy in one place ensures both call sites:
 *  - never include the malformed prior response in the retry prompt
 *    (don't trust output that just misbehaved);
 *  - drop temperature to 0 on retry;
 *  - sum input/output tokens across both attempts so cost accounting is
 *    accurate.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { calculateCost } from '@/lib/orchestration/llm/cost-tracker';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type { getProvider } from '@/lib/orchestration/llm/provider-manager';

type LlmProvider = Awaited<ReturnType<typeof getProvider>>;

export interface StructuredCompletionOptions<T> {
  provider: LlmProvider;
  model: string;
  messages: LlmMessage[];
  parse: (raw: string) => T | null;
  /** Sent as a `user` message on retry. Should describe the expected shape. */
  retryUserMessage: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Optional caller-supplied error to throw when both attempts fail. */
  onFinalFailure?: () => Error;
}

export interface StructuredCompletionResult<T> {
  value: T;
  tokenUsage: { input: number; output: number };
  costUsd: number;
}

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_TIMEOUT_MS = 10_000;

export async function runStructuredCompletion<T>(
  opts: StructuredCompletionOptions<T>
): Promise<StructuredCompletionResult<T>> {
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const firstSignal = AbortSignal.timeout(timeoutMs);
  const first = await opts.provider.chat(opts.messages, {
    model: opts.model,
    temperature,
    maxTokens,
    signal: firstSignal,
  });

  const firstParsed = opts.parse(first.content);
  if (firstParsed !== null) {
    const inputTokens = first.usage.inputTokens;
    const outputTokens = first.usage.outputTokens;
    return {
      value: firstParsed,
      tokenUsage: { input: inputTokens, output: outputTokens },
      costUsd: calculateCost(opts.model, inputTokens, outputTokens).totalCostUsd,
    };
  }

  // Retry with a stricter prompt at temperature 0. We do NOT include
  // the malformed prior response — never trust output that just
  // misbehaved as part of a subsequent prompt.
  const retrySignal = AbortSignal.timeout(timeoutMs);
  const retry = await opts.provider.chat(
    [...opts.messages, { role: 'user', content: opts.retryUserMessage }],
    {
      model: opts.model,
      temperature: 0,
      maxTokens,
      signal: retrySignal,
    }
  );

  const retryParsed = opts.parse(retry.content);
  if (retryParsed === null) {
    if (opts.onFinalFailure) throw opts.onFinalFailure();
    throw new Error('Structured completion response was not valid JSON after retry');
  }

  const inputTokens = first.usage.inputTokens + retry.usage.inputTokens;
  const outputTokens = first.usage.outputTokens + retry.usage.outputTokens;
  return {
    value: retryParsed,
    tokenUsage: { input: inputTokens, output: outputTokens },
    costUsd: calculateCost(opts.model, inputTokens, outputTokens).totalCostUsd,
  };
}

/**
 * Try to parse `raw` as JSON, then run it through `validate`. The model
 * may include surrounding whitespace or a stray code fence even when
 * asked not to — we try the raw string first, then strip common wrappers.
 */
export function tryParseJson<T>(raw: string, validate: (parsed: unknown) => T | null): T | null {
  const candidates = [raw.trim(), stripCodeFence(raw.trim())];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const validated = validate(parsed);
      if (validated !== null) return validated;
    } catch {
      // fall through
    }
  }
  return null;
}

export function stripCodeFence(input: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const match = input.match(fence);
  return match ? match[1] : input;
}
