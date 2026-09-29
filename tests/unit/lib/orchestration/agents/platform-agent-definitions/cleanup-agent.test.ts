/**
 * Tests: the clean-up assistant's starting model (§116 t-724; moved from the
 * retired `020-cleanup-agent` seed).
 *
 * Cleanup is a tool-choice-heavy task, so rather than inherit the install's
 * default chat model the agent starts on the strongest tool-using model the
 * org can actually REACH. When to consult this — only while the org has
 * chosen neither provider nor model — is the reconcile's rule and is tested
 * there.
 *
 * @see lib/orchestration/agents/platform-agent-definitions/cleanup-agent.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { TenancyClient } from '@/lib/db/tenancy-extension';
import {
  CLEANUP_AGENT,
  pickCleanupBinding,
} from '@/lib/orchestration/agents/platform-agent-definitions/cleanup-agent';

function providerRow(slug: string, apiKeyEnvVar: string | null, isLocal = false) {
  return { slug, isLocal, apiKeyEnvVar };
}

function modelRow(
  providerSlug: string,
  modelId: string,
  tierRole = 'worker',
  reasoningDepth = 'high'
) {
  return { providerSlug, modelId, tierRole, reasoningDepth };
}

function db(providers: unknown[], models: unknown[]) {
  const modelFindMany = vi.fn().mockResolvedValue(models);
  return {
    client: {
      aiProviderConfig: { findMany: vi.fn().mockResolvedValue(providers) },
      aiProviderModel: { findMany: modelFindMany },
    } as unknown as TenancyClient,
    modelFindMany,
  };
}

describe('pickCleanupBinding', () => {
  const savedKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  it('picks the strongest reachable tool-using model, with a stable tie-break', async () => {
    // Both worker-tier with strong tools; the model id decides.
    const { client, modelFindMany } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'gpt-4o'), modelRow('openai', 'gpt-4.1')]
    );

    expect(await pickCleanupBinding(client)).toEqual({ provider: 'openai', model: 'gpt-4.1' });
    expect(modelFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerSlug: { in: ['openai'] },
          toolUse: 'strong',
          capabilities: { has: 'chat' },
        }),
      })
    );
  });

  it('prefers a worker-tier model over a thinking-tier one', async () => {
    // A whole-document rewrite on a thinking-tier model costs far more and is
    // no better at choosing between two regex tools.
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'gpt-5', 'thinking', 'very_high'), modelRow('openai', 'gpt-4.1')]
    );

    expect(await pickCleanupBinding(client)).toEqual({ provider: 'openai', model: 'gpt-4.1' });
  });

  it('ignores a provider whose api-key env var is not set', async () => {
    // Pinning an unreachable provider would break a path that works today.
    delete process.env.NOT_SET_KEY;
    const { client, modelFindMany } = db(
      [providerRow('ghost', 'NOT_SET_KEY')],
      [modelRow('ghost', 'ghost-1')]
    );

    expect(await pickCleanupBinding(client)).toBeNull();
    expect(modelFindMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing reachable, so no model read at all
  });

  it('accepts a local provider that needs no api key', async () => {
    const { client } = db([providerRow('ollama', null, true)], [modelRow('ollama', 'llama3')]);

    expect(await pickCleanupBinding(client)).toEqual({ provider: 'ollama', model: 'llama3' });
  });

  it('breaks a tier tie by reasoning depth, and ranks an unknown tier or depth last', async () => {
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [
        modelRow('openai', 'a-unknown-tier', 'mystery', 'very_high'),
        modelRow('openai', 'b-worker-unknown-depth', 'worker', 'mystery'),
        modelRow('openai', 'c-worker-medium', 'worker', 'medium'),
        modelRow('openai', 'd-control', 'control_plane', 'very_high'),
      ]
    );

    // Worker tier first; within it, a known depth beats an unknown one.
    expect(await pickCleanupBinding(client)).toEqual({
      provider: 'openai',
      model: 'c-worker-medium',
    });
  });

  it('prefers a control-plane model to one of an unknown tier', async () => {
    const { client } = db(
      [providerRow('openai', 'OPENAI_API_KEY')],
      [modelRow('openai', 'a-unknown', 'mystery'), modelRow('openai', 'z-control', 'control_plane')]
    );

    expect(await pickCleanupBinding(client)).toEqual({ provider: 'openai', model: 'z-control' });
  });

  it('returns null when no reachable model is tool-capable', async () => {
    const { client } = db([providerRow('openai', 'OPENAI_API_KEY')], []);

    expect(await pickCleanupBinding(client)).toBeNull();
  });
});

describe('CLEANUP_AGENT', () => {
  it('is bound to all fourteen cleanup capabilities and consults the picker', () => {
    expect(CLEANUP_AGENT.capabilities).toEqual([
      'read_document',
      'find_in_document',
      'strip_lines_matching',
      'strip_matches',
      'strip_timestamps',
      'strip_speaker_labels',
      'collapse_whitespace',
      'join_wrapped_lines',
      'dedupe_lines',
      'normalise_punctuation',
      'preview_diff',
      'estimate_size',
      'rewrite_with_llm',
      'rewrite_section_with_llm',
    ]);
    expect(CLEANUP_AGENT.defaultBinding).toBe(pickCleanupBinding);
    // Content only the current prompt has.
    expect(CLEANUP_AGENT.agent.systemInstructions).toContain('join_wrapped_lines');
  });
});
