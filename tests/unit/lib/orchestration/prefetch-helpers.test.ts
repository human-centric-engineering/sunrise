/**
 * Unit Tests: prefetch-helpers (getProviders, getModels)
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

// Mocks must be declared before imports per Vitest hoisting rules.
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { getProviders, getModels } from '@/lib/orchestration/prefetch-helpers';

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
