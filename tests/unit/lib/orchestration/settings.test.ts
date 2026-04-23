/**
 * Unit tests for lib/orchestration/settings.ts
 *
 * Covers the three exported functions:
 *   - parseStoredDefaults: valid input, invalid shapes (null, undefined, string, array,
 *     nested non-string values) all returning `{}`
 *   - hydrateSettings: stored values win over computed defaults; missing keys fall back
 *   - getOrchestrationSettings: calls prisma.upsert with correct args, returns hydrated result
 *
 * @see lib/orchestration/settings.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ─── Mock dependencies before module import ───────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiOrchestrationSettings: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  computeDefaultModelMap: vi.fn(() => ({
    routing: 'claude-haiku-4-5',
    chat: 'claude-haiku-4-5',
    reasoning: 'claude-opus-4-6',
    embeddings: 'claude-haiku-4-5',
  })),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { computeDefaultModelMap } from '@/lib/orchestration/llm/model-registry';
import {
  parseStoredDefaults,
  parseSearchConfig,
  hydrateSettings,
  getOrchestrationSettings,
} from '@/lib/orchestration/settings';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-11T00:00:00.000Z');

function makeRow(
  overrides: Partial<{
    defaultModels: Prisma.JsonValue;
    globalMonthlyBudgetUsd: number | null;
    searchConfig: Prisma.JsonValue | null;
    lastSeededAt: Date | null;
    defaultApprovalTimeoutMs: number | null;
    approvalDefaultAction: string | null;
    inputGuardMode: string | null;
    outputGuardMode: string | null;
    webhookRetentionDays: number | null;
    costLogRetentionDays: number | null;
    auditLogRetentionDays: number | null;
    maxConversationsPerUser: number | null;
    maxMessagesPerConversation: number | null;
  }> = {}
) {
  return {
    id: 'cmjbv4i3x00003wsloputgwu1',
    slug: 'global' as const,
    defaultModels: {
      routing: 'claude-haiku-4-5',
      chat: 'claude-sonnet-4-6',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    } satisfies Prisma.JsonObject,
    globalMonthlyBudgetUsd: null as number | null,
    searchConfig: null as Prisma.JsonValue | null,
    lastSeededAt: null as Date | null,
    defaultApprovalTimeoutMs: null as number | null,
    approvalDefaultAction: 'deny' as string | null,
    inputGuardMode: 'log_only' as string | null,
    outputGuardMode: 'log_only' as string | null,
    webhookRetentionDays: null as number | null,
    costLogRetentionDays: null as number | null,
    auditLogRetentionDays: null as number | null,
    maxConversationsPerUser: null as number | null,
    maxMessagesPerConversation: null as number | null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseStoredDefaults', () => {
  describe('valid input', () => {
    it('returns the object as-is when all values are strings', () => {
      const input = { routing: 'claude-haiku-4-5', chat: 'claude-sonnet-4-6' };
      expect(parseStoredDefaults(input)).toEqual(input);
    });

    it('returns an empty object when the input is an empty object', () => {
      expect(parseStoredDefaults({})).toEqual({});
    });
  });

  describe('invalid input collapses to {}', () => {
    it('returns {} when input is null', () => {
      expect(parseStoredDefaults(null)).toEqual({});
    });

    it('returns {} when input is undefined', () => {
      expect(parseStoredDefaults(undefined)).toEqual({});
    });

    it('returns {} when input is a string', () => {
      expect(parseStoredDefaults('not-an-object')).toEqual({});
    });

    it('returns {} when input is an array', () => {
      expect(parseStoredDefaults(['claude-haiku-4-5'])).toEqual({});
    });

    it('returns {} when values are numbers instead of strings', () => {
      // z.record(z.string(), z.string()) will reject number values
      expect(parseStoredDefaults({ chat: 42 })).toEqual({});
    });

    it('returns {} when values are nested objects instead of strings', () => {
      expect(parseStoredDefaults({ chat: { id: 'claude-haiku-4-5' } })).toEqual({});
    });

    it('returns {} when values contain a mix of valid and invalid types', () => {
      // An object where any value fails string validation collapses entirely
      expect(parseStoredDefaults({ chat: 'claude-sonnet-4-6', routing: 99 })).toEqual({});
    });

    it('returns {} when input is a boolean', () => {
      expect(parseStoredDefaults(true)).toEqual({});
    });

    it('returns {} when input is a number', () => {
      expect(parseStoredDefaults(123)).toEqual({});
    });
  });
});

describe('parseSearchConfig', () => {
  it('returns a valid SearchConfig when input is well-formed', () => {
    expect(parseSearchConfig({ keywordBoostWeight: -0.05, vectorWeight: 1.2 })).toEqual({
      keywordBoostWeight: -0.05,
      vectorWeight: 1.2,
    });
  });

  it('returns null when input is null', () => {
    expect(parseSearchConfig(null)).toBeNull();
  });

  it('returns null when input is undefined', () => {
    expect(parseSearchConfig(undefined)).toBeNull();
  });

  it('returns null when keywordBoostWeight is out of range (positive)', () => {
    expect(parseSearchConfig({ keywordBoostWeight: 0.5, vectorWeight: 1.0 })).toBeNull();
  });

  it('returns null when vectorWeight is out of range (too high)', () => {
    expect(parseSearchConfig({ keywordBoostWeight: -0.02, vectorWeight: 5.0 })).toBeNull();
  });

  it('returns null when input is a string', () => {
    expect(parseSearchConfig('not-an-object')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseSearchConfig({ keywordBoostWeight: -0.02 })).toBeNull();
  });
});

describe('hydrateSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeDefaultModelMap).mockReturnValue({
      routing: 'claude-haiku-4-5',
      chat: 'claude-haiku-4-5',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    });
  });

  it('returns an OrchestrationSettings object with the correct shape', () => {
    const row = makeRow();
    const result = hydrateSettings(row);

    expect(result.id).toBe(row.id);
    expect(result.slug).toBe('global');
    expect(result.globalMonthlyBudgetUsd).toBeNull();
    expect(result.searchConfig).toBeNull();
    expect(result.lastSeededAt).toBeNull();
    expect(result.createdAt).toBe(NOW);
    expect(result.updatedAt).toBe(NOW);
    expect(typeof result.defaultModels).toBe('object');
  });

  it('parses valid searchConfig from stored JSON', () => {
    const row = makeRow({
      searchConfig: { keywordBoostWeight: -0.05, vectorWeight: 1.2 },
    });
    const result = hydrateSettings(row);
    expect(result.searchConfig).toEqual({ keywordBoostWeight: -0.05, vectorWeight: 1.2 });
  });

  it('returns null searchConfig when stored JSON is invalid', () => {
    const row = makeRow({ searchConfig: 'bad-data' });
    const result = hydrateSettings(row);
    expect(result.searchConfig).toBeNull();
  });

  it('passes through lastSeededAt when set', () => {
    const seeded = new Date('2026-04-15T12:00:00Z');
    const row = makeRow({ lastSeededAt: seeded });
    const result = hydrateSettings(row);
    expect(result.lastSeededAt).toBe(seeded);
  });

  it('stored values override computed defaults for every known task type', () => {
    const row = makeRow({
      defaultModels: {
        routing: 'claude-sonnet-4-6',
        chat: 'claude-sonnet-4-6',
        reasoning: 'claude-sonnet-4-6',
        embeddings: 'claude-sonnet-4-6',
      },
    });

    const result = hydrateSettings(row);

    expect(result.defaultModels.routing).toBe('claude-sonnet-4-6');
    expect(result.defaultModels.chat).toBe('claude-sonnet-4-6');
    expect(result.defaultModels.reasoning).toBe('claude-sonnet-4-6');
    expect(result.defaultModels.embeddings).toBe('claude-sonnet-4-6');
  });

  it('falls back to computed defaults for task keys missing from stored map', () => {
    // Only 'chat' is stored; all other task types must come from computeDefaultModelMap
    const row = makeRow({ defaultModels: { chat: 'claude-sonnet-4-6' } });

    const result = hydrateSettings(row);

    expect(result.defaultModels.chat).toBe('claude-sonnet-4-6');
    expect(result.defaultModels.routing).toBe('claude-haiku-4-5');
    expect(result.defaultModels.reasoning).toBe('claude-opus-4-6');
    expect(result.defaultModels.embeddings).toBe('claude-haiku-4-5');
  });

  it('uses entirely computed defaults when stored defaultModels is an empty object', () => {
    const row = makeRow({ defaultModels: {} });

    const result = hydrateSettings(row);

    expect(result.defaultModels).toEqual({
      routing: 'claude-haiku-4-5',
      chat: 'claude-haiku-4-5',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    });
  });

  it('uses entirely computed defaults when stored defaultModels is invalid JSON (string)', () => {
    const row = makeRow({ defaultModels: 'not-an-object' });

    const result = hydrateSettings(row);

    expect(result.defaultModels).toEqual({
      routing: 'claude-haiku-4-5',
      chat: 'claude-haiku-4-5',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    });
  });

  it('uses entirely computed defaults when stored defaultModels is null', () => {
    // Prisma.JsonValue includes null
    const row = makeRow({ defaultModels: null });

    const result = hydrateSettings(row);

    expect(result.defaultModels).toEqual({
      routing: 'claude-haiku-4-5',
      chat: 'claude-haiku-4-5',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    });
  });

  it('uses entirely computed defaults when stored values are non-string (numbers)', () => {
    const row = makeRow({ defaultModels: { chat: 42, routing: 99 } });

    const result = hydrateSettings(row);

    expect(result.defaultModels).toEqual({
      routing: 'claude-haiku-4-5',
      chat: 'claude-haiku-4-5',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    });
  });

  it('does not include stored empty-string values — falls back to computed default', () => {
    // hydrateSettings checks `val.length > 0` before accepting a stored value
    const row = makeRow({
      defaultModels: {
        routing: '',
        chat: 'claude-sonnet-4-6',
        reasoning: '',
        embeddings: '',
      },
    });

    const result = hydrateSettings(row);

    // Empty strings are rejected; computed defaults fill in
    expect(result.defaultModels.routing).toBe('claude-haiku-4-5');
    expect(result.defaultModels.reasoning).toBe('claude-opus-4-6');
    expect(result.defaultModels.embeddings).toBe('claude-haiku-4-5');
    // Non-empty stored value still wins
    expect(result.defaultModels.chat).toBe('claude-sonnet-4-6');
  });

  it('preserves globalMonthlyBudgetUsd when set to a positive number', () => {
    const row = makeRow({ globalMonthlyBudgetUsd: 500 });

    const result = hydrateSettings(row);

    expect(result.globalMonthlyBudgetUsd).toBe(500);
  });

  it('slug is always "global" regardless of the row slug value', () => {
    // The implementation hard-codes slug: 'global' in the returned object
    const row = makeRow();

    const result = hydrateSettings(row);

    expect(result.slug).toBe('global');
  });
});

describe('getOrchestrationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeDefaultModelMap).mockReturnValue({
      routing: 'claude-haiku-4-5',
      chat: 'claude-haiku-4-5',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    });
  });

  it('calls prisma.aiOrchestrationSettings.upsert with slug "global"', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(makeRow() as never);

    await getOrchestrationSettings();

    expect(prisma.aiOrchestrationSettings.upsert).toHaveBeenCalledOnce();
    expect(prisma.aiOrchestrationSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'global' } })
    );
  });

  it('passes computed defaults as the create payload', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(makeRow() as never);

    await getOrchestrationSettings();

    expect(prisma.aiOrchestrationSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          slug: 'global',
          globalMonthlyBudgetUsd: null,
          searchConfig: Prisma.JsonNull,
          lastSeededAt: null,
        }),
      })
    );
  });

  it('passes an empty update object so existing rows are not overwritten', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(makeRow() as never);

    await getOrchestrationSettings();

    expect(prisma.aiOrchestrationSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} })
    );
  });

  it('returns the hydrated OrchestrationSettings shape', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(makeRow() as never);

    const result = await getOrchestrationSettings();

    expect(result.id).toBe('cmjbv4i3x00003wsloputgwu1');
    expect(result.slug).toBe('global');
    expect(result.globalMonthlyBudgetUsd).toBeNull();
    expect(result.createdAt).toEqual(NOW);
    expect(result.updatedAt).toEqual(NOW);
    expect(typeof result.defaultModels).toBe('object');
  });

  it('merges stored values correctly in the returned result', async () => {
    // Stored row has chat overridden; everything else falls back to computed
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
      makeRow({ defaultModels: { chat: 'claude-sonnet-4-6' } }) as never
    );

    const result = await getOrchestrationSettings();

    expect(result.defaultModels.chat).toBe('claude-sonnet-4-6');
    expect(result.defaultModels.routing).toBe('claude-haiku-4-5');
    expect(result.defaultModels.reasoning).toBe('claude-opus-4-6');
    expect(result.defaultModels.embeddings).toBe('claude-haiku-4-5');
  });

  it('returns entirely computed defaults when the upsert row has invalid stored models', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockResolvedValue(
      makeRow({ defaultModels: null }) as never
    );

    const result = await getOrchestrationSettings();

    expect(result.defaultModels).toEqual({
      routing: 'claude-haiku-4-5',
      chat: 'claude-haiku-4-5',
      reasoning: 'claude-opus-4-6',
      embeddings: 'claude-haiku-4-5',
    });
  });

  it('propagates a prisma upsert rejection', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.upsert).mockRejectedValue(
      new Error('DB connection failed')
    );

    await expect(getOrchestrationSettings()).rejects.toThrow('DB connection failed');
  });
});
