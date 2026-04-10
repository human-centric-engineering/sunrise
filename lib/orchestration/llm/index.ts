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

export * from './types';
export type { LlmProvider, ProviderTestResult } from './provider';
export { ProviderError } from './provider';
export { AnthropicProvider } from './anthropic';
export { OpenAiCompatibleProvider } from './openai-compatible';
export * as modelRegistry from './model-registry';
export * as providerManager from './provider-manager';
export * as costTracker from './cost-tracker';
