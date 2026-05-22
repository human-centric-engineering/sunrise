/**
 * Tests for the DB hydration coordinator.
 *
 * Verifies the bridge between operator-curated AiProviderModel rows and
 * the in-memory registry's state map. The registry's `__resetForTests`
 * and the hydration module's own `__resetForTests` clean cross-test
 * state — without both, the TTL throttle leaks between cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockFindMany = vi.fn();
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: { findMany: mockFindMany },
  },
}));

const registry = await import('@/lib/orchestration/llm/model-registry');
const hydrate = await import('@/lib/orchestration/llm/model-registry-db-hydrate');
const logging = await import('@/lib/logging');

beforeEach(() => {
  mockFindMany.mockReset();
  registry.__resetForTests();
  hydrate.__resetForTests();
  vi.mocked(logging.logger.warn).mockReset();
});

// Minimum field set the adapter needs to produce a ModelInfo. Mirrors
// an active AiProviderModel row without dragging in the whole Prisma
// type — the test only cares about the bridge behaviour.
// A fictitious operator-added model id (NOT present in the registry's
// hardcoded fallback) — proves DB hydration is the path that surfaces it.
// Using a real id like 'gpt-5' couples the test to whatever the fallback
// happens to ship at any given time.
const CUSTOM_MODEL_ID = 'acme-custom-thinker';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cuid_test',
    slug: 'acme-acme-custom-thinker',
    providerSlug: 'acme',
    modelId: CUSTOM_MODEL_ID,
    name: 'Acme Custom Thinker',
    description: '',
    capabilities: ['chat'],
    tierRole: 'thinking',
    deploymentProfiles: ['hosted'],
    paramProfile: null,
    reasoningDepth: 'very_high',
    latency: 'medium',
    costEfficiency: 'medium',
    contextLength: 'very_high',
    toolUse: 'strong',
    bestRole: '',
    dimensions: null,
    schemaCompatible: null,
    costPerMillionTokens: null,
    local: false,
    quality: null,
    strengths: null,
    setup: null,
    isDefault: false,
    isActive: true,
    metadata: null,
    createdBy: 'user_test',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('hydrateFromDb', () => {
  it('merges active DB rows into the in-memory registry so getModel resolves them', async () => {
    // The motivating case: an operator-added model is in the Model
    // Matrix but not in the registry's hardcoded fallback. Without
    // hydration, a step's `modelOverride: '<custom>'` semantic-validates
    // to UNKNOWN_MODEL_OVERRIDE.
    expect(registry.getModel(CUSTOM_MODEL_ID)).toBeUndefined();

    mockFindMany.mockResolvedValue([makeRow()]);
    await hydrate.hydrateFromDb();

    const model = registry.getModel(CUSTOM_MODEL_ID);
    expect(model).toBeDefined();
    expect(model?.provider).toBe('acme');
    expect(model?.supportsTools).toBe(true); // toolUse: 'strong' → true
  });

  it('only queries the DB once per TTL window', async () => {
    mockFindMany.mockResolvedValue([]);

    await hydrate.hydrateFromDb();
    await hydrate.hydrateFromDb();
    await hydrate.hydrateFromDb();

    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('soft-fails when the DB query throws — registry retains prior state, warn logged', async () => {
    mockFindMany.mockRejectedValue(new Error('connection refused'));

    // Should not throw — the validator surfaces a clearer error than a
    // runtime crash if a DB-only model is missing.
    await expect(hydrate.hydrateFromDb()).resolves.toBeUndefined();

    // Fallback models still resolvable after the failed hydration.
    expect(registry.getModel('gpt-4o-mini')).toBeDefined();
    expect(registry.getModel(CUSTOM_MODEL_ID)).toBeUndefined();

    expect(vi.mocked(logging.logger.warn)).toHaveBeenCalledWith(
      'Model registry: hydrateFromDb failed',
      expect.objectContaining({ error: 'connection refused' })
    );
  });

  it('DB row overrides a same-id fallback entry — admin matrix beats hardcoded list', async () => {
    mockFindMany.mockResolvedValue([
      makeRow({
        providerSlug: 'openai',
        modelId: 'gpt-4o-mini',
        slug: 'openai-gpt-4o-mini',
        name: 'GPT-4o Mini (Operator-curated)',
        tierRole: 'thinking', // upgrade tier from the fallback's 'budget'
      }),
    ]);
    await hydrate.hydrateFromDb();

    const model = registry.getModel('gpt-4o-mini');
    expect(model?.name).toBe('GPT-4o Mini (Operator-curated)');
    expect(model?.tier).toBe('frontier'); // 'thinking' tierRole → 'frontier' tier
  });

  it('deduplicates concurrent calls — only one DB query for parallel callers', async () => {
    // Without the `inflight` promise, two concurrent workflow executions
    // could each fire their own SELECT during the same tick.
    mockFindMany.mockResolvedValue([]);

    await Promise.all([hydrate.hydrateFromDb(), hydrate.hydrateFromDb(), hydrate.hydrateFromDb()]);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });
});
