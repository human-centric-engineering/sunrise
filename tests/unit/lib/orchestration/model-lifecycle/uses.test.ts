/**
 * Everything that uses a model, and the dated models still in use (§136 t-1065).
 *
 * `providerModelUsage` is mocked: its cross-org counting has its own tests
 * beside `global-config-usage`. What is tested here is the composition, and
 * which dated models count as in use, by state.
 *
 * @see lib/orchestration/model-lifecycle/uses.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { aiProviderModel: { findMany: vi.fn() } },
}));
vi.mock('@/lib/orchestration/admin/global-config-usage', () => ({
  providerModelUsage: vi.fn(),
}));
vi.mock('@/lib/orchestration/settings', () => ({ getOrchestrationSettings: vi.fn() }));

import { prisma } from '@/lib/db/client';
import { providerModelUsage } from '@/lib/orchestration/admin/global-config-usage';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { isInUse, modelUses, retiringModelsInUse } from '@/lib/orchestration/model-lifecycle/uses';

const NOW = new Date('2027-03-01T12:00:00.000Z');
const FUTURE = new Date('2027-06-01T00:00:00.000Z');
const PAST = new Date('2027-01-01T00:00:00.000Z');

const UNUSED = {
  agents: [],
  workflows: [],
  otherOrgAgents: 0,
  otherOrgAgentsFollowingPlatform: 0,
  otherOrgWorkflows: 0,
};

const SETTINGS = {
  defaultModels: { routing: '', chat: 'pinned-chat', reasoning: '', embeddings: '', audio: '' },
  defaultModelsStored: { chat: 'pinned-chat' },
  confidentialModel: null,
  activeEmbeddingModelId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrchestrationSettings).mockResolvedValue(SETTINGS as never);
  vi.mocked(providerModelUsage).mockResolvedValue(UNUSED);
});

describe('modelUses', () => {
  it('adds the settings pins to the agent and workflow usage, passing the scope through', async () => {
    const uses = await modelUses(
      { id: 'm1', providerSlug: 'openai', modelId: 'pinned-chat' },
      { acrossOrgs: false }
    );

    expect(providerModelUsage).toHaveBeenCalledWith('openai', 'pinned-chat', { acrossOrgs: false });
    expect(uses).toEqual({ ...UNUSED, settings: [{ slot: 'chat', source: 'saved' }] });
  });
});

describe('isInUse', () => {
  it.each([
    ['an own agent', { agents: [{ id: 'a', name: 'A', slug: 'a', followsPlatform: false }] }],
    ["another org's agent", { otherOrgAgents: 1 }],
    ['an own workflow', { workflows: [{ id: 'w', name: 'W', slug: 'w' }] }],
    ["another org's workflow", { otherOrgWorkflows: 1 }],
    ['a setting', { settings: [{ slot: 'chat' as const, source: 'saved' as const }] }],
  ])('is true for %s', (_label, part) => {
    expect(isInUse({ ...UNUSED, settings: [], ...part })).toBe(true);
  });

  it('is false for nothing', () => {
    expect(isInUse({ ...UNUSED, settings: [] })).toBe(false);
  });
});

describe('retiringModelsInUse', () => {
  function dated(rows: Array<{ id: string; modelId: string; retiresAt: Date }>) {
    vi.mocked(prisma.aiProviderModel.findMany).mockResolvedValue(
      rows.map((r) => ({ ...r, providerSlug: 'openai' })) as never
    );
  }

  it('reads only models with a retirement date, and nothing else when there are none', async () => {
    dated([]);

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 0 });
    expect(prisma.aiProviderModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { retiresAt: { not: null } } })
    );
    expect(getOrchestrationSettings).not.toHaveBeenCalled();
  });

  it('counts each dated model in use by its state at the time given, and skips unused ones', async () => {
    dated([
      { id: 'r1', modelId: 'retiring-used', retiresAt: FUTURE },
      { id: 'r2', modelId: 'retiring-unused', retiresAt: FUTURE },
      { id: 'd1', modelId: 'retired-used', retiresAt: PAST },
      { id: 'd2', modelId: 'pinned-chat', retiresAt: PAST },
    ]);
    vi.mocked(providerModelUsage).mockImplementation(async (_provider, modelId) =>
      modelId === 'retiring-used' || modelId === 'retired-used'
        ? { ...UNUSED, otherOrgAgents: 2 }
        : UNUSED
    );

    // `pinned-chat` is used only by a setting, which counts too.
    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 1, retired: 2 });
    // Counted across every org: no scope narrowing.
    expect(providerModelUsage).toHaveBeenCalledWith('openai', 'retiring-used');
  });
});
