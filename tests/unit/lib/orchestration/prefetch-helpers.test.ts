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
