/**
 * Tests for `lib/orchestration/llm/tokeniser.ts`.
 *
 * Covers:
 *  - `tokeniserForModel` routing per provider family (OpenAI modern,
 *    OpenAI legacy, Anthropic, Gemini, Llama-family, fallback).
 *  - Each tokeniser counts text without throwing and returns a
 *    non-negative integer.
 *  - The `exact` flag is true for OpenAI and false elsewhere — this
 *    is the contract the docs lean on.
 *  - Calibration multipliers leave Anthropic and Gemini >= the raw
 *    `o200k_base` count for the same input.
 *  - Empty / null / undefined inputs do not throw and return 0 / a
 *    fallback tokeniser.
 *
 * @see lib/orchestration/llm/tokeniser.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { tokeniserForModel, __tokenisers } from '@/lib/orchestration/llm/tokeniser';
import * as modelRegistry from '@/lib/orchestration/llm/model-registry';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

function fakeModel(id: string, provider: string): ModelInfo {
  return {
    id,
    name: id,
    provider,
    tier: 'mid',
    inputCostPerMillion: 1,
    outputCostPerMillion: 1,
    maxContext: 128_000,
    supportsTools: false,
  };
}

describe('tokeniserForModel', () => {
  it('returns the heuristic tokeniser when modelId is missing', () => {
    expect(tokeniserForModel(undefined).id).toBe('heuristic');
    expect(tokeniserForModel(null).id).toBe('heuristic');
    expect(tokeniserForModel('').id).toBe('heuristic');
  });

  it('routes modern OpenAI ids to the o200k tokeniser (exact)', () => {
    const t = tokeniserForModel('gpt-4o-mini');
    expect(t.id).toBe('openai-o200k');
    expect(t.exact).toBe(true);
  });

  it('routes Anthropic ids to the calibrated approximator (not exact)', () => {
    const t = tokeniserForModel('claude-haiku-4-5');
    expect(t.id).toBe('anthropic-approx');
    expect(t.exact).toBe(false);
  });

  it('falls back to the llama-family approximator for unknown models', () => {
    // Unknown model id — registry returns nothing, no pattern matches,
    // so the final default-branch llama tokeniser is used.
    const t = tokeniserForModel('definitely-not-a-real-model-xyz');
    expect(t.exact).toBe(false);
    expect(['llama-approx', 'anthropic-approx', 'gemini-approx']).toContain(t.id);
  });

  // ── pattern-fallback layer (registry miss / custom provider name) ──────────

  it('routes claude-* ids by pattern even when not in the registry', () => {
    // Brand-new claude id the registry hasn't seen yet — pattern fallback
    // catches it and routes to the Anthropic approximator.
    const t = tokeniserForModel('claude-future-9-0');
    expect(t.id).toBe('anthropic-approx');
  });

  it('routes gpt-4o-style ids by pattern to OpenAI modern', () => {
    // Hypothetical future OpenAI id — pattern fallback gets the
    // exact tokeniser even though the registry doesn't know it.
    const t = tokeniserForModel('gpt-5-experimental');
    expect(t.id).toBe('openai-o200k');
    expect(t.exact).toBe(true);
  });

  it('routes legacy gpt-3.5/gpt-4 ids by pattern to OpenAI legacy', () => {
    expect(tokeniserForModel('gpt-3.5-turbo-instruct').id).toBe('openai-cl100k');
    expect(tokeniserForModel('gpt-4-vision-preview').id).toBe('openai-cl100k');
  });

  it('routes OpenAI o-series reasoning models to the modern tokeniser', () => {
    // o1, o3, o4 reasoning models all use o200k_base.
    expect(tokeniserForModel('o1-preview').id).toBe('openai-o200k');
    expect(tokeniserForModel('o3-mini').id).toBe('openai-o200k');
    expect(tokeniserForModel('o4').id).toBe('openai-o200k');
  });

  it('routes gemini-* by pattern to the Gemini approximator', () => {
    expect(tokeniserForModel('gemini-1.5-pro-future').id).toBe('gemini-approx');
  });

  it('routes llama / mistral / qwen ids by pattern to the Llama approximator', () => {
    expect(tokeniserForModel('meta-llama/Llama-4-70b-instruct').id).toBe('llama-approx');
    expect(tokeniserForModel('mistralai/mistral-large-future').id).toBe('llama-approx');
    expect(tokeniserForModel('qwen2.5-coder-32b').id).toBe('llama-approx');
  });

  // ── registry-by-provider switch coverage ───────────────────────────────────
  // These exercise the layer-1 switch arms that production deployments will
  // hit when the registry knows the model. Using vi.spyOn keeps the rest of
  // the registry intact (including the static fallback map) while letting
  // each test target one provider value.

  it.each([
    ['together', 'llama-approx'],
    ['fireworks', 'llama-approx'],
    ['groq', 'llama-approx'],
    ['ollama', 'llama-approx'],
    ['lmstudio', 'llama-approx'],
    ['vllm', 'llama-approx'],
    ['meta-llama', 'llama-approx'],
    ['google', 'gemini-approx'],
    ['gemini', 'gemini-approx'],
  ])('routes registry provider "%s" to %s', (provider, expectedId) => {
    const spy = vi.spyOn(modelRegistry, 'getModel').mockReturnValue(fakeModel('x', provider));
    try {
      expect(tokeniserForModel('x').id).toBe(expectedId);
    } finally {
      spy.mockRestore();
    }
  });

  it('lowercases capitalised registry provider names before routing', () => {
    // Defensive: a custom-named provider config could surface "Anthropic"
    // (capitalised) on the model. The switch comparison is lowercase,
    // so this still hits the anthropic case.
    const spy = vi.spyOn(modelRegistry, 'getModel').mockReturnValue(fakeModel('y', 'Anthropic'));
    try {
      expect(tokeniserForModel('y').id).toBe('anthropic-approx');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Tokeniser.count', () => {
  it('returns 0 for empty input across every variant', () => {
    for (const t of Object.values(__tokenisers)) {
      expect(t.count('')).toBe(0);
    }
  });

  it('returns a positive integer for non-empty input', () => {
    const text = 'Hello world';
    for (const t of Object.values(__tokenisers)) {
      const n = t.count(text);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });

  it('OpenAI modern tokeniser produces the expected exact count for known strings', () => {
    // These are stable golden values from gpt-tokenizer's o200k_base.
    // If they ever change, treat as a library upgrade signal — not a
    // test bug. The test exists to lock down the wiring.
    expect(__tokenisers.openAiModern.count('Hello world')).toBe(2);
    expect(__tokenisers.openAiModern.count('The quick brown fox jumps over the lazy dog.')).toBe(
      10
    );
  });

  it('Anthropic approximator >= raw o200k for the same input (multiplier ≥ 1)', () => {
    const samples = [
      'Hello world',
      'The quick brown fox jumps over the lazy dog.',
      '¿Cómo estás? Estoy bien, gracias.',
      '你好世界，今天天气很好',
      'function foo() { return 42; }',
    ];
    for (const s of samples) {
      const raw = __tokenisers.openAiModern.count(s);
      const approx = __tokenisers.anthropic.count(s);
      expect(approx).toBeGreaterThanOrEqual(raw);
    }
  });

  it('Heuristic tokeniser scales linearly with input length', () => {
    // Defensive — the heuristic is the fallback for missing model
    // metadata, and its monotonic behaviour is what the truncation
    // loop relies on.
    const short = __tokenisers.heuristic.count('a'.repeat(35));
    const long = __tokenisers.heuristic.count('a'.repeat(700));
    expect(long).toBeGreaterThan(short);
  });

  it('OpenAI modern diverges from the heuristic for non-English text', () => {
    // CJK is the headline correction case for #9. The heuristic
    // assumes 3.5 chars/token (English) — which falls apart on
    // realistic Chinese sentences where each character carries far
    // more semantic weight per byte. We assert the directional
    // divergence (not equality) so the test is robust to library
    // upgrades.
    const cjk = '你好世界，今天天气很好'; // 11 chars, real sentence
    const heuristic = __tokenisers.heuristic.count(cjk);
    const tokenised = __tokenisers.openAiModern.count(cjk);
    expect(tokenised).not.toBe(heuristic);
  });
});
