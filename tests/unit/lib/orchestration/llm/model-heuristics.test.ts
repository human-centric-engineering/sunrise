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
  anthropicThinkingBudget,
  deriveBestRole,
  deriveContextLength,
  deriveCostEfficiency,
  deriveDeploymentProfiles,
  deriveLatency,
  deriveMatrixSlug,
  deriveParamProfile,
  deriveReasoningDepth,
  deriveTierRole,
  deriveToolUse,
  narrowReasoningEffort,
  supportedReasoningEfforts,
  supportsReasoningEffort,
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

describe('deriveParamProfile', () => {
  it('anthropic provider always maps to the anthropic profile', () => {
    expect(deriveParamProfile('claude-sonnet-4', 'anthropic')).toBe('anthropic');
    expect(deriveParamProfile('claude-haiku-4.5', 'anthropic')).toBe('anthropic');
  });

  it('gemini provider always maps to the gemini profile', () => {
    expect(deriveParamProfile('gemini-2.5-pro', 'gemini')).toBe('gemini');
    expect(deriveParamProfile('any-model-id', 'gemini')).toBe('gemini');
  });

  it('OpenAI reasoning + gpt-5 families map to openai-reasoning', () => {
    expect(deriveParamProfile('gpt-5', 'openai')).toBe('openai-reasoning');
    expect(deriveParamProfile('gpt-5-mini', 'openai')).toBe('openai-reasoning');
    expect(deriveParamProfile('o1', 'openai')).toBe('openai-reasoning');
    expect(deriveParamProfile('o3-mini', 'openai')).toBe('openai-reasoning');
    expect(deriveParamProfile('o4-preview', 'openai')).toBe('openai-reasoning');
  });

  it('strips provider prefixes so OpenRouter-style ids still match — this is the failure case that motivated promoting the routing into the registry', () => {
    expect(deriveParamProfile('openai/gpt-5-mini', 'openai')).toBe('openai-reasoning');
    expect(deriveParamProfile('azure/gpt-5', 'openai')).toBe('openai-reasoning');
    expect(deriveParamProfile('openai/o3-mini', 'openai')).toBe('openai-reasoning');
  });

  it('does NOT match reasoning patterns mid-id (anchored regex prevents false positives)', () => {
    // A fine-tuned model that happens to contain "gpt-5" as a substring
    // somewhere other than the start should not be treated as a
    // reasoning model.
    expect(deriveParamProfile('my-fine-tuned-gpt-5-fork', 'openai')).toBe('openai-legacy');
    expect(deriveParamProfile('foo-o3-mini', 'openai')).toBe('openai-legacy');
  });

  it('falls back to openai-legacy for everything else', () => {
    expect(deriveParamProfile('gpt-4o', 'openai')).toBe('openai-legacy');
    expect(deriveParamProfile('gpt-4o-mini', 'openai')).toBe('openai-legacy');
    expect(deriveParamProfile('gpt-4.1', 'openai')).toBe('openai-legacy');
    // OpenAI-compatible hosts of non-OpenAI models all use legacy
    // chat-completions conventions.
    expect(deriveParamProfile('llama-3.3-70b-versatile', 'groq')).toBe('openai-legacy');
    expect(deriveParamProfile('mixtral-8x7b-32768', 'groq')).toBe('openai-legacy');
    expect(deriveParamProfile('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together')).toBe(
      'openai-legacy'
    );
  });
});

describe('supportsReasoningEffort', () => {
  it('any model with the openai-reasoning profile supports it', () => {
    expect(supportsReasoningEffort('gpt-5', 'openai', 'openai-reasoning')).toBe(true);
    expect(supportsReasoningEffort('o3-mini', 'openai', 'openai-reasoning')).toBe(true);
    // Profile is authoritative — even a non-openai provider name with the
    // reasoning profile counts as supported (an admin could in principle
    // route reasoning models through an OpenAI-compatible reseller).
    expect(supportsReasoningEffort('gpt-5', 'azure', 'openai-reasoning')).toBe(true);
  });

  it('Claude Opus 4.x supports thinking', () => {
    expect(supportsReasoningEffort('claude-opus-4', 'anthropic', 'anthropic')).toBe(true);
    expect(supportsReasoningEffort('claude-opus-4-6', 'anthropic', 'anthropic')).toBe(true);
    expect(supportsReasoningEffort('claude-opus-4-20250514', 'anthropic', 'anthropic')).toBe(true);
  });

  it('Claude Sonnet 4.5+ supports thinking; Sonnet 4 does NOT', () => {
    expect(supportsReasoningEffort('claude-sonnet-4-5', 'anthropic', 'anthropic')).toBe(true);
    expect(supportsReasoningEffort('claude-sonnet-4-6', 'anthropic', 'anthropic')).toBe(true);
    // Sonnet 4 (no .5 / -5) does not support thinking — exclusion case
    // motivated by the failing-test risk of an over-broad regex.
    expect(supportsReasoningEffort('claude-sonnet-4', 'anthropic', 'anthropic')).toBe(false);
  });

  it('handles multi-digit future versions (4-10, 5-2, version 10+) without manual regex updates', () => {
    // Forward-compat audit case — earlier regex used `[5-9]` character
    // classes that capped at single-digit minors. These must work today
    // (the cost is one regex constant, the alternative is rotting code).
    expect(supportsReasoningEffort('claude-sonnet-4-10', 'anthropic', 'anthropic')).toBe(true);
    expect(supportsReasoningEffort('claude-sonnet-4-15', 'anthropic', 'anthropic')).toBe(true);
    expect(supportsReasoningEffort('claude-sonnet-5-2', 'anthropic', 'anthropic')).toBe(true);
    expect(supportsReasoningEffort('claude-sonnet-10', 'anthropic', 'anthropic')).toBe(true);
    expect(supportsReasoningEffort('claude-opus-5-3', 'anthropic', 'anthropic')).toBe(true);
    expect(supportsReasoningEffort('claude-opus-10', 'anthropic', 'anthropic')).toBe(true);
    // Sonnet 4-0..4-4 must STAY excluded even with the widened regex —
    // the audit caught an earlier draft that accidentally swallowed
    // them by anchoring incorrectly.
    expect(supportsReasoningEffort('claude-sonnet-4-0', 'anthropic', 'anthropic')).toBe(false);
    expect(supportsReasoningEffort('claude-sonnet-4-4', 'anthropic', 'anthropic')).toBe(false);
  });

  it('accepts both dot and hyphen separators between major and minor (4.5 ↔ 4-5)', () => {
    expect(supportsReasoningEffort('claude-sonnet-4.5', 'anthropic', 'anthropic')).toBe(true);
    expect(supportsReasoningEffort('claude-sonnet-4.5-20250601', 'anthropic', 'anthropic')).toBe(
      true
    );
  });

  it('Claude Haiku is NOT a thinking model regardless of version', () => {
    expect(supportsReasoningEffort('claude-haiku-4-5', 'anthropic', 'anthropic')).toBe(false);
    expect(supportsReasoningEffort('claude-haiku-4', 'anthropic', 'anthropic')).toBe(false);
  });

  it('strips Bedrock and OpenRouter prefixes before matching', () => {
    expect(
      supportsReasoningEffort('anthropic.claude-opus-4-20250514-v1:0', 'anthropic', 'anthropic')
    ).toBe(true);
    expect(supportsReasoningEffort('anthropic/claude-opus-4', 'anthropic', 'anthropic')).toBe(true);
  });

  it('returns false for legacy / non-reasoning models', () => {
    expect(supportsReasoningEffort('gpt-4o', 'openai', 'openai-legacy')).toBe(false);
    expect(supportsReasoningEffort('gpt-4.1', 'openai', 'openai-legacy')).toBe(false);
    expect(supportsReasoningEffort('llama-3.3-70b', 'groq', 'openai-legacy')).toBe(false);
    expect(supportsReasoningEffort('gemini-2.5-pro', 'gemini', 'gemini')).toBe(false);
  });
});

describe('narrowReasoningEffort', () => {
  it('passes through the four enum values verbatim', () => {
    expect(narrowReasoningEffort('minimal')).toBe('minimal');
    expect(narrowReasoningEffort('low')).toBe('low');
    expect(narrowReasoningEffort('medium')).toBe('medium');
    expect(narrowReasoningEffort('high')).toBe('high');
  });

  it('returns undefined for null / undefined / empty input', () => {
    expect(narrowReasoningEffort(null)).toBeUndefined();
    expect(narrowReasoningEffort(undefined)).toBeUndefined();
    expect(narrowReasoningEffort('')).toBeUndefined();
  });

  it('returns undefined for unrecognised strings rather than narrowing to a phantom enum member', () => {
    // Operator wrote garbage via raw SQL, or a forked backup bundle
    // carries a value we don't know. Must drop to undefined — otherwise
    // the value reaches provider.chat() and 400s on OpenAI's enum check.
    expect(narrowReasoningEffort('banana')).toBeUndefined();
    expect(narrowReasoningEffort('HIGH')).toBeUndefined(); // case-sensitive
    expect(narrowReasoningEffort('reasoning')).toBeUndefined();
    expect(narrowReasoningEffort('auto')).toBeUndefined(); // form sentinel must not leak
  });
});

describe('supportedReasoningEfforts', () => {
  it('o-series models exclude `minimal` (added in gpt-5; o-series 400s on it)', () => {
    expect(supportedReasoningEfforts('o1', 'openai')).toEqual(new Set(['low', 'medium', 'high']));
    expect(supportedReasoningEfforts('o1-mini', 'openai')).toEqual(
      new Set(['low', 'medium', 'high'])
    );
    expect(supportedReasoningEfforts('o3-mini', 'openai')).toEqual(
      new Set(['low', 'medium', 'high'])
    );
    expect(supportedReasoningEfforts('o4-mini', 'openai')).toEqual(
      new Set(['low', 'medium', 'high'])
    );
  });

  it('gpt-5 family supports all four buckets including `minimal`', () => {
    expect(supportedReasoningEfforts('gpt-5', 'openai')).toEqual(
      new Set(['minimal', 'low', 'medium', 'high'])
    );
    expect(supportedReasoningEfforts('gpt-5-mini', 'openai')).toEqual(
      new Set(['minimal', 'low', 'medium', 'high'])
    );
  });

  it('strips known provider prefixes before applying the o-series rule', () => {
    expect(supportedReasoningEfforts('openai/o3-mini', 'openai')).toEqual(
      new Set(['low', 'medium', 'high'])
    );
    expect(supportedReasoningEfforts('azure/o1', 'openai')).toEqual(
      new Set(['low', 'medium', 'high'])
    );
  });

  it('non-reasoning models return the full set (the openai-compatible class drops the field anyway via the profile check)', () => {
    expect(supportedReasoningEfforts('gpt-4o', 'openai')).toEqual(
      new Set(['minimal', 'low', 'medium', 'high'])
    );
    expect(supportedReasoningEfforts('llama-3.3-70b', 'groq')).toEqual(
      new Set(['minimal', 'low', 'medium', 'high'])
    );
  });

  it('does not apply the o-series rule to anthropic-routed models that happen to start with "o"', () => {
    // Defensive — a Claude model id that hypothetically started with
    // "o" must not be treated as an OpenAI o-series. Provider guard
    // prevents this even if the regex would otherwise match.
    expect(supportedReasoningEfforts('o-some-future-claude', 'anthropic')).toEqual(
      new Set(['minimal', 'low', 'medium', 'high'])
    );
  });
});

describe('anthropicThinkingBudget', () => {
  it('returns undefined for minimal (extended thinking is off)', () => {
    expect(anthropicThinkingBudget('minimal')).toBeUndefined();
  });

  it('returns increasing budgets for low / medium / high', () => {
    expect(anthropicThinkingBudget('low')).toBe(1024);
    expect(anthropicThinkingBudget('medium')).toBe(4096);
    expect(anthropicThinkingBudget('high')).toBe(16384);
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
