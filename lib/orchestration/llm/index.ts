/**
 * Public surface of the LLM provider abstraction.
 *
 * Consumers (chat handler, workflow engine, evaluation harness) import
 * from this barrel and never reach into concrete provider files.
 *
 * Internal helpers (`fetchWithTimeout`, `withRetry`, the static fallback
 * map) are intentionally not re-exported — they are implementation
 * details that should stay private to this module.
 */

export * from '@/lib/orchestration/llm/types';
export type { LlmProvider, ProviderTestResult } from '@/lib/orchestration/llm/provider';
export { ProviderError } from '@/lib/orchestration/llm/provider';
export { AnthropicProvider } from '@/lib/orchestration/llm/anthropic';
export { OpenAiCompatibleProvider } from '@/lib/orchestration/llm/openai-compatible';
export * as modelRegistry from '@/lib/orchestration/llm/model-registry';
export * as providerManager from '@/lib/orchestration/llm/provider-manager';
export * as costTracker from '@/lib/orchestration/llm/cost-tracker';
export {
  recommendModels,
  recommendProviders,
  invalidateModelCache,
  invalidateProfileCache,
  type ModelRecommendation,
  type ProviderRecommendation,
  type RecommendOptions,
} from '@/lib/orchestration/llm/provider-selector';
