/**
 * Capability Inference Tests
 *
 * Table-driven coverage of `inferCapability(providerSlug, modelId)` —
 * one row per (provider, modelId, expected capability). The function
 * has no side effects and no dependencies, so these tests double as
 * its specification.
 *
 * @see lib/orchestration/llm/capability-inference.ts
 */

import { describe, it, expect } from 'vitest';

import { inferCapability, type Capability } from '@/lib/orchestration/llm/capability-inference';

describe('inferCapability', () => {
  const cases: Array<[string, string, Capability]> = [
    // OpenAI — chat
    ['openai', 'gpt-4o', 'chat'],
    ['openai', 'gpt-4o-mini', 'chat'],
    ['openai', 'gpt-5', 'chat'],
    ['openai', 'gpt-4.1', 'chat'],
    ['openai', 'chatgpt-4o-latest', 'chat'],

    // OpenAI — reasoning (the bug that motivated this work — these
    // 404 against /v1/chat/completions and need the /v1/responses
    // surface, which the panel can't currently exercise)
    ['openai', 'o1', 'reasoning'],
    ['openai', 'o1-mini', 'reasoning'],
    ['openai', 'o3', 'reasoning'],
    ['openai', 'o3-pro-2025-06-10', 'reasoning'],
    ['openai', 'o4-mini', 'reasoning'],

    // OpenAI — embedding
    ['openai', 'text-embedding-3-small', 'embedding'],
    ['openai', 'text-embedding-3-large', 'embedding'],
    ['openai', 'text-embedding-ada-002', 'embedding'],

    // OpenAI — image
    ['openai', 'dall-e-3', 'image'],
    ['openai', 'dall-e-2', 'image'],
    ['openai', 'gpt-image-1', 'image'],

    // OpenAI — audio
    ['openai', 'whisper-1', 'audio'],
    ['openai', 'tts-1', 'audio'],
    ['openai', 'tts-1-hd', 'audio'],

    // OpenAI — moderation
    ['openai', 'omni-moderation-latest', 'moderation'],
    ['openai', 'text-moderation-007', 'moderation'],

    // OpenAI — unknown (we don't blindly fall through to chat —
    // unrecognised ids stay unknown so the test button gets disabled)
    ['openai', 'davinci-002', 'unknown'],

    // Voyage — embeddings only
    ['voyage', 'voyage-3', 'embedding'],
    ['voyage', 'voyage-large-2', 'embedding'],
    ['voyage', 'rerank-2', 'embedding'],

    // Cohere
    ['cohere', 'command-r-plus', 'chat'],
    ['cohere', 'embed-english-v3.0', 'embedding'],
    ['cohere', 'rerank-multilingual-v3.0', 'embedding'],

    // Google
    ['google', 'gemini-2.0-flash', 'chat'],
    ['google', 'gemini-1.5-pro', 'chat'],
    ['google', 'gemini-embedding-exp-03-07', 'embedding'],
    ['google', 'text-embedding-004', 'embedding'],
    ['google', 'imagen-3', 'image'],

    // Mistral — chat-centric, embed exposed
    ['mistral', 'mistral-large-latest', 'chat'],
    ['mistral', 'mistral-embed', 'embedding'],

    // Chat-centric providers — assume chat for unrecognised ids
    ['anthropic', 'claude-sonnet-4-6', 'chat'],
    ['anthropic', 'claude-haiku-4-5', 'chat'],
    ['groq', 'llama-3.3-70b-versatile', 'chat'],
    ['together', 'meta-llama/Llama-3-70b-chat-hf', 'chat'],
    ['fireworks', 'accounts/fireworks/models/llama-v3p1-70b-instruct', 'chat'],
    ['ollama', 'llama3:70b', 'chat'],

    // OpenAI-API-compatible providers that serve Whisper through
    // /v1/audio/transcriptions. Limited to providers whose backing
    // class (OpenAiCompatibleProvider) implements transcribe() — the
    // matrix should auto-tag these as audio so operators see the
    // right test surface and the Default: Audio dropdown picks them.
    ['groq', 'whisper-large-v3', 'audio'],
    ['groq', 'distil-whisper-large-v3-en', 'audio'],
    ['together', 'openai/whisper-large-v3', 'audio'],
    ['fireworks', 'whisper-v3', 'audio'],
    ['openai-compatible', 'whisper-1', 'audio'],

    // Anthropic doesn't have audio — don't false-positive on the
    // 'whisper' substring (defensive against future model ids that
    // include it for unrelated reasons).
    ['anthropic', 'claude-whisper-experiment', 'chat'],

    // Unknown providers fall through without claiming chat
    ['custom-vendor', 'unknown-model', 'unknown'],
  ];

  for (const [slug, modelId, expected] of cases) {
    it(`${slug} / ${modelId} → ${expected}`, () => {
      expect(inferCapability(slug, modelId)).toBe(expected);
    });
  }

  it('is case-insensitive on slug + modelId', () => {
    expect(inferCapability('OpenAI', 'GPT-4O')).toBe('chat');
    expect(inferCapability('VOYAGE', 'Voyage-3')).toBe('embedding');
  });
});
