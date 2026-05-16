/**
 * Unit Tests: prefetch-helpers (getProviders, getModels, getEffectiveAgentDefaults)
 *
 * Test Coverage:
 * - getProviders: returns array on success
 * - getProviders: returns null when res.ok is false
 * - getProviders: returns null when body.success is false
 * - getProviders: returns null and logs on exception
 * - getModels: returns flat array when API returns a flat array
 * - getModels: normalises { models: [...] } wrapped response shape
 * - getModels: returns null when res.ok is false
 * - getModels: returns null when body.success is false
 * - getModels: returns null for unexpected data shape
 * - getModels: returns null and logs on exception
 * - getEffectiveAgentDefaults: explicit values pass through unchanged
 * - getEffectiveAgentDefaults: empty provider falls back to first reachable provider
 * - getEffectiveAgentDefaults: empty model falls back to configured default chat model
 * - getEffectiveAgentDefaults: returns empty values gracefully on lookup failure
 * - getEffectiveAgentDefaults: marks inherited fields with flags
 *
 * @see lib/orchestration/prefetch-helpers.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isApiKeyEnvVarSet: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTaskOrNull: vi.fn(),
}));

// Mocks must be declared before imports per Vitest hoisting rules.
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import {
  getAgentModels,
  getProviders,
  getModels,
  getEffectiveAgentDefaults,
} from '@/lib/orchestration/prefetch-helpers';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', slug: 'anthropic' },
  { id: 'openai', name: 'OpenAI', slug: 'openai' },
];

const MODELS_FLAT = [
  { provider: 'anthropic', id: 'claude-3-5-sonnet', tier: 'frontier' },
  { provider: 'openai', id: 'gpt-4o', tier: 'frontier' },
];

function okRes(): Response {
  return { ok: true } as Response;
}
function notOkRes(): Response {
  return { ok: false } as Response;
}

// ─── Tests: getProviders ──────────────────────────────────────────────────────

describe('getProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the providers array on a successful response', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okRes());
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: PROVIDERS } as never);

    const result = await getProviders();

    expect(result).toEqual(PROVIDERS);
  });

  it('returns null when res.ok is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkRes());

    const result = await getProviders();

    expect(result).toBeNull();
  });

  it('returns null when body.success is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okRes());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'fail' },
    } as never);

    const result = await getProviders();

    expect(result).toBeNull();
  });

  it('returns null and logs the error when serverFetch throws', async () => {
    const err = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(err);

    const result = await getProviders();

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('prefetch: provider fetch failed', err);
  });
});

// ─── Tests: getModels ────────────────────────────────────────────────────────

describe('getModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a flat array when the API returns data as a plain array', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okRes());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MODELS_FLAT,
    } as never);

    const result = await getModels();

    expect(result).toEqual(MODELS_FLAT);
  });

  it('normalises the { models: [...] } wrapped response shape', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okRes());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: { models: MODELS_FLAT },
    } as never);

    const result = await getModels();

    expect(result).toEqual(MODELS_FLAT);
  });

  it('returns null when res.ok is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(notOkRes());

    const result = await getModels();

    expect(result).toBeNull();
  });

  it('returns null when body.success is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okRes());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'fail' },
    } as never);

    const result = await getModels();

    expect(result).toBeNull();
  });

  it('returns null for an unexpected data shape (object without models key)', async () => {
    vi.mocked(serverFetch).mockResolvedValue(okRes());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: { unexpected: 'shape' },
    } as never);

    const result = await getModels();

    expect(result).toBeNull();
  });

  it('returns null and logs the error when serverFetch throws', async () => {
    const err = new Error('Registry unreachable');
    vi.mocked(serverFetch).mockRejectedValue(err);

    const result = await getModels();

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('prefetch: model registry fetch failed', err);
  });
});

// ─── Tests: getAgentModels ───────────────────────────────────────────────────

describe('getAgentModels', () => {
  // The agent form's model dropdown source — restricted to operator-curated
  // matrix rows with capability=chat OR capability=reasoning. Settings
  // already uses the same source for its Default Models picker; this
  // helper aligns the agent form so an operator can't pick a model the
  // deployment never configured.

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMatrixRow(
    overrides: Partial<{
      providerSlug: string;
      modelId: string;
      capabilities: string[];
      tierRole: string;
      deploymentProfiles: string[];
    }> = {}
  ) {
    return {
      providerSlug: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      capabilities: ['chat'],
      tierRole: 'thinking',
      deploymentProfiles: ['hosted'],
      ...overrides,
    };
  }

  it('fetches /provider-models with capability=chat AND capability=reasoning in parallel', async () => {
    // Two URLs in flight at once — the API's `capability` filter is a
    // single value, so reasoning-only models (e.g. `o1-mini` with
    // capabilities=['reasoning']) wouldn't appear under capability=chat.
    vi.mocked(serverFetch).mockImplementation((url: string) => {
      expect(url).toMatch(/\/provider-models\?capability=(chat|reasoning)&isActive=true/);
      return Promise.resolve(okRes());
    });
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [makeMatrixRow()],
    } as never);

    await getAgentModels();

    expect(serverFetch).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(serverFetch).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('capability=chat'))).toBe(true);
    expect(calls.some((c) => c.includes('capability=reasoning'))).toBe(true);
  });

  it('merges the two responses and dedups by (provider, modelId)', async () => {
    // A model tagged with BOTH chat and reasoning capabilities shows up
    // in both responses; the helper must dedup so the agent form
    // doesn't render two identical options.
    const dualCapability = makeMatrixRow({
      modelId: 'gpt-5',
      providerSlug: 'openai',
      capabilities: ['chat', 'reasoning'],
    });
    const reasoningOnly = makeMatrixRow({
      modelId: 'o1-mini',
      providerSlug: 'openai',
      capabilities: ['reasoning'],
      tierRole: 'thinking',
    });
    vi.mocked(serverFetch).mockResolvedValue(okRes());
    vi.mocked(parseApiResponse).mockImplementation((res: Response) => {
      // The test's mock returns the same response regardless of URL,
      // but the parseApiResponse mock can branch on which call it is —
      // chatRes resolves first (the dual one), reasoningRes resolves
      // second (both dual and reasoning-only). Returning the SAME
      // dual row in both responses is what triggers the dedup branch.
      void res;
      const callIdx = vi.mocked(parseApiResponse).mock.calls.length;
      if (callIdx === 1) return Promise.resolve({ success: true, data: [dualCapability] } as never);
      return Promise.resolve({
        success: true,
        data: [dualCapability, reasoningOnly],
      } as never);
    });

    const result = await getAgentModels();

    expect(result).toHaveLength(2);
    expect(result?.map((m) => m.id).sort()).toEqual(['gpt-5', 'o1-mini']);
  });

  it('maps tierRole + deploymentProfiles to a ModelOption tier hint', async () => {
    const sovereign = makeMatrixRow({
      modelId: 'llama-3.3-70b',
      providerSlug: 'meta',
      tierRole: 'worker',
      deploymentProfiles: ['sovereign'],
    });
    const frontier = makeMatrixRow({
      modelId: 'claude-3-5-sonnet',
      providerSlug: 'anthropic',
      tierRole: 'thinking',
      deploymentProfiles: ['hosted'],
    });
    const budget = makeMatrixRow({
      modelId: 'gpt-4o-mini',
      providerSlug: 'openai',
      tierRole: 'infrastructure',
      deploymentProfiles: ['hosted'],
    });
    vi.mocked(serverFetch).mockResolvedValue(okRes());
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [sovereign, frontier, budget],
    } as never);

    const result = await getAgentModels();

    const byId = new Map(result?.map((m) => [m.id, m]) ?? []);
    // Sovereign deployment overrides the tier-role mapping → 'local'.
    expect(byId.get('llama-3.3-70b')?.tier).toBe('local');
    // thinking → frontier; infrastructure → budget.
    expect(byId.get('claude-3-5-sonnet')?.tier).toBe('frontier');
    expect(byId.get('gpt-4o-mini')?.tier).toBe('budget');
  });

  it('returns the chat-only rows when the reasoning fetch fails', async () => {
    // Tolerant: if one of the two parallel fetches fails (network blip,
    // 5xx) the helper still returns whatever rows the other call
    // produced rather than collapsing the whole dropdown to null.
    vi.mocked(serverFetch).mockImplementation((url: string) =>
      Promise.resolve(url.includes('capability=chat') ? okRes() : notOkRes())
    );
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: [makeMatrixRow()],
    } as never);

    const result = await getAgentModels();

    expect(result).toHaveLength(1);
    expect(result?.[0].id).toBe('claude-3-5-sonnet');
  });

  it('returns null when both fetches fail', async () => {
    // The agent form treats null as "show free-text fallback" — same
    // posture as getModels().
    vi.mocked(serverFetch).mockResolvedValue(notOkRes());

    const result = await getAgentModels();

    expect(result).toBeNull();
  });

  it('returns null and logs when serverFetch throws', async () => {
    const err = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(err);

    const result = await getAgentModels();

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('prefetch: agent matrix fetch failed', err);
  });
});

// ─── Tests: getEffectiveAgentDefaults ─────────────────────────────────────────

describe('getEffectiveAgentDefaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes explicit provider/model through unchanged without DB lookups', async () => {
    const result = await getEffectiveAgentDefaults({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(result).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inheritedProvider: false,
      inheritedModel: false,
    });
    expect(prisma.aiProviderConfig.findMany).not.toHaveBeenCalled();
    expect(getDefaultModelForTaskOrNull).not.toHaveBeenCalled();
  });

  it('fills empty provider from the first reachable active provider', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      {
        id: 'p1',
        slug: 'openai',
        isLocal: false,
        apiKeyEnvVar: 'OPENAI_KEY',
      },
      {
        id: 'p2',
        slug: 'anthropic',
        isLocal: false,
        apiKeyEnvVar: 'ANTHROPIC_KEY',
      },
    ] as never);
    // First provider's key is missing; second one is reachable
    vi.mocked(isApiKeyEnvVarSet).mockImplementation((v) => v === 'ANTHROPIC_KEY');
    vi.mocked(getDefaultModelForTaskOrNull).mockResolvedValue('claude-opus-4-6');

    const result = await getEffectiveAgentDefaults({ provider: '', model: '' });

    expect(result).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inheritedProvider: true,
      inheritedModel: true,
    });
  });

  it('treats local providers as reachable even without an env key', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      { id: 'p1', slug: 'ollama', isLocal: true, apiKeyEnvVar: null },
    ] as never);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(false);
    vi.mocked(getDefaultModelForTaskOrNull).mockResolvedValue('llama-3');

    const result = await getEffectiveAgentDefaults({ provider: '', model: '' });

    expect(result.provider).toBe('ollama');
    expect(result.inheritedProvider).toBe(true);
  });

  it('keeps provider empty when no reachable provider exists', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      { id: 'p1', slug: 'openai', isLocal: false, apiKeyEnvVar: 'OPENAI_KEY' },
    ] as never);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(false);
    vi.mocked(getDefaultModelForTaskOrNull).mockResolvedValue('claude-opus-4-6');

    const result = await getEffectiveAgentDefaults({ provider: '', model: '' });

    expect(result.provider).toBe('');
    expect(result.inheritedProvider).toBe(true);
  });

  it('keeps model empty when no system default is configured', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);
    vi.mocked(getDefaultModelForTaskOrNull).mockResolvedValue(null);

    const result = await getEffectiveAgentDefaults({
      provider: 'anthropic',
      model: '',
    });

    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('');
    expect(result.inheritedProvider).toBe(false);
    expect(result.inheritedModel).toBe(true);
  });

  it('tolerates a DB failure during provider lookup', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockRejectedValue(new Error('DB down'));
    vi.mocked(getDefaultModelForTaskOrNull).mockResolvedValue('claude-opus-4-6');

    const result = await getEffectiveAgentDefaults({ provider: '', model: '' });

    expect(result.provider).toBe('');
    expect(result.model).toBe('claude-opus-4-6');
    expect(logger.warn).toHaveBeenCalledWith(
      'prefetch: effective provider lookup failed',
      expect.objectContaining({ error: 'DB down' })
    );
  });

  it('tolerates a failure when reading the default model setting', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);
    vi.mocked(getDefaultModelForTaskOrNull).mockRejectedValue(new Error('settings down'));

    const result = await getEffectiveAgentDefaults({ provider: 'anthropic', model: '' });

    expect(result.model).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(
      'prefetch: effective model lookup failed',
      expect.objectContaining({ error: 'settings down' })
    );
  });
});
