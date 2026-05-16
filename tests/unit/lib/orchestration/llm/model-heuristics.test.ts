/**
 * Model Heuristics Tests
 *
 * Table-driven coverage of the pure derivation functions used by the
 * discovery endpoint to pre-fill matrix metadata. Each row is one
 * (input, expected) pair — adding a new heuristic case means adding
 * a row, not a new test.
 *
 * @see lib/orchestration/llm/model-heuristics.ts
 */

import { describe, it, expect } from 'vitest';

import {
  deriveBestRole,
  deriveContextLength,
  deriveCostEfficiency,
  deriveDeploymentProfiles,
  deriveLatency,
  deriveMatrixSlug,
  deriveReasoningDepth,
  deriveTierRole,
  deriveToolUse,
} from '@/lib/orchestration/llm/model-heuristics';

describe('deriveCostEfficiency', () => {
  const cases: Array<[number | null, string]> = [
    [0.15, 'very_high'], // gpt-4o-mini
    [0.5, 'very_high'],
    [0.6, 'high'],
    [2, 'high'], // Sonnet 4.6 boundary
    [3, 'medium'],
    [10, 'medium'],
    [15, 'none'], // Opus 4.6
    [75, 'none'],
    [null, 'medium'], // unknown
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(deriveCostEfficiency(input)).toBe(expected);
    });
  }
});

describe('deriveContextLength', () => {
  const cases: Array<[number | null, string]> = [
    [200_000, 'high'],
    [128_000, 'high'],
    [127_999, 'medium'],
    [32_000, 'medium'],
    [31_999, 'n_a'],
    [8_192, 'n_a'],
    [1_000_000, 'very_high'],
    [2_000_000, 'very_high'],
    [0, 'n_a'],
    [null, 'n_a'],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(deriveContextLength(input)).toBe(expected);
    });
  }
});

describe('deriveLatency', () => {
  const cases: Array<[string, string]> = [
    ['gpt-4o-mini', 'fast'],
    ['gpt-4o', 'medium'],
    ['claude-haiku-4-5', 'fast'],
    ['claude-sonnet-4-6', 'medium'],
    ['claude-opus-4-6', 'medium'],
    ['gemini-flash', 'fast'],
    ['gemini-flash-lite', 'very_fast'],
    ['gpt-4-nano', 'very_fast'],
    ['gpt-3.5-turbo', 'fast'],
    ['o3-pro-2025-06-10', 'medium'],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(deriveLatency(input)).toBe(expected);
    });
  }
});

describe('deriveReasoningDepth', () => {
  const cases: Array<[string, 'chat' | 'embedding' | 'image' | 'audio', string]> = [
    ['claude-opus-4-6', 'chat', 'very_high'],
    ['o3-pro-2025-06-10', 'chat', 'very_high'],
    ['o1-mini', 'chat', 'very_high'],
    ['o4-mini', 'chat', 'very_high'],
    ['claude-sonnet-4-6', 'chat', 'high'],
    ['gpt-4o', 'chat', 'high'],
    ['gpt-5', 'chat', 'high'],
    ['gemini-pro', 'chat', 'high'],
    ['claude-haiku-4-5', 'chat', 'medium'],
    ['gpt-4o-mini', 'chat', 'medium'],
    ['gemini-flash', 'chat', 'medium'],
    ['llama-3.3-70b-versatile', 'chat', 'medium'],
    // Non-chat capabilities → none regardless of model id
    ['claude-opus-4-6', 'embedding', 'none'],
    ['text-embedding-3-small', 'embedding', 'none'],
    ['dall-e-3', 'image', 'none'],
    ['whisper-1', 'audio', 'none'],
  ];
  for (const [modelId, capability, expected] of cases) {
    it(`${modelId} (${capability}) → ${expected}`, () => {
      expect(deriveReasoningDepth(modelId, capability)).toBe(expected);
    });
  }
});

describe('deriveTierRole', () => {
  it('embedding capability → embedding tier', () => {
    expect(
      deriveTierRole({
        capability: 'embedding',
        reasoningDepth: 'none',
        costEfficiency: 'high',
        latency: 'fast',
      })
    ).toBe('embedding');
  });

  it('frontier reasoning → thinking tier (regardless of locality)', () => {
    // A local-deployable thinking-tier model (Qwen 2.5 72B style) gets
    // classified by its capability tier, not by where it runs. Deployment
    // locus is `deploymentProfiles`, which used to overlap with this tier
    // via `local_sovereign` — removed 2026-05-16.
    expect(
      deriveTierRole({
        capability: 'chat',
        reasoningDepth: 'very_high',
        costEfficiency: 'none',
        latency: 'medium',
      })
    ).toBe('thinking');
  });

  it('cheap + fast → worker tier', () => {
    expect(
      deriveTierRole({
        capability: 'chat',
        reasoningDepth: 'medium',
        costEfficiency: 'very_high',
        latency: 'fast',
      })
    ).toBe('worker');
  });

  it('default fallback → infrastructure tier', () => {
    expect(
      deriveTierRole({
        capability: 'chat',
        reasoningDepth: 'high',
        costEfficiency: 'medium',
        latency: 'medium',
      })
    ).toBe('infrastructure');
  });
});

describe('deriveToolUse', () => {
  it('supportsTools=true and chat → strong', () => {
    expect(deriveToolUse({ supportsTools: true, capability: 'chat' })).toBe('strong');
  });
  it('supportsTools=false and chat → moderate', () => {
    expect(deriveToolUse({ supportsTools: false, capability: 'chat' })).toBe('moderate');
  });
  it('embedding → none regardless of supportsTools', () => {
    expect(deriveToolUse({ supportsTools: true, capability: 'embedding' })).toBe('none');
  });
  it('image / audio / moderation → none', () => {
    expect(deriveToolUse({ supportsTools: false, capability: 'image' })).toBe('none');
    expect(deriveToolUse({ supportsTools: false, capability: 'audio' })).toBe('none');
    expect(deriveToolUse({ supportsTools: false, capability: 'moderation' })).toBe('none');
  });
});

describe('deriveBestRole', () => {
  it('embedding capability overrides tier', () => {
    expect(deriveBestRole('embedding', 'embedding')).toBe('Embedding for KB search');
    expect(deriveBestRole('thinking', 'embedding')).toBe('Embedding for KB search');
  });
  it('image / audio / moderation map directly', () => {
    expect(deriveBestRole('infrastructure', 'image')).toBe('Image generation');
    expect(deriveBestRole('infrastructure', 'audio')).toBe('Audio transcription / synthesis');
    expect(deriveBestRole('infrastructure', 'moderation')).toBe('Content moderation');
  });
  it('chat tier picks descriptive phrase', () => {
    expect(deriveBestRole('thinking', 'chat')).toMatch(/planner/i);
    expect(deriveBestRole('worker', 'chat')).toMatch(/worker/i);
    expect(deriveBestRole('infrastructure', 'chat')).toMatch(/workhorse/i);
    expect(deriveBestRole('control_plane', 'chat')).toMatch(/routing/i);
  });
});

describe('deriveDeploymentProfiles', () => {
  it('local model → [sovereign]', () => {
    expect(deriveDeploymentProfiles({ isLocal: true })).toEqual(['sovereign']);
  });

  it('non-local model → [hosted]', () => {
    expect(deriveDeploymentProfiles({ isLocal: false })).toEqual(['hosted']);
  });
});

describe('deriveMatrixSlug', () => {
  const cases: Array<[string, string, string]> = [
    ['openai', 'gpt-5', 'openai-gpt-5'],
    ['openai', 'GPT-5', 'openai-gpt-5'],
    ['Anthropic', 'claude-sonnet-4-6', 'anthropic-claude-sonnet-4-6'],
    ['voyage', 'voyage-3', 'voyage-voyage-3'],
    // Special characters collapse to single hyphens
    ['openai', 'gpt-4.1', 'openai-gpt-4-1'],
    ['openai', 'o3-pro-2025-06-10', 'openai-o3-pro-2025-06-10'],
    // Empty parts handled
    ['openai', '', 'openai'],
  ];
  for (const [providerSlug, modelId, expected] of cases) {
    it(`(${providerSlug}, ${modelId}) → ${expected}`, () => {
      expect(deriveMatrixSlug(providerSlug, modelId)).toBe(expected);
    });
  }
});
