/**
 * Everything that uses a model, and the dated models still in use (§136 t-1065).
 *
 * `providerModelUsage` is mocked: its cross-org counting has its own tests
 * beside `global-config-usage`. What is tested here is the composition, how a
 * model id two providers share is treated (never guessed), and which dated
 * models count as in use, by state.
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
  defaultModels: { routing: '', chat: '', reasoning: '', embeddings: '', audio: '' },
  defaultModelsStored: {},
  confidentialModel: null,
  activeEmbeddingModelId: null,
};

interface Row {
  id: string;
  providerSlug: string;
  modelId: string;
  retiresAt: Date | null;
}

/**
 * The catalogue `findMany` answers from: the dated-model read
 * (`retiresAt: { not: null }`) and the same-id read (`modelId` on other
 * providers).
 */
function catalogue(rows: Row[]) {
  vi.mocked(prisma.aiProviderModel.findMany).mockImplementation(((args: {
    where: { retiresAt?: unknown; modelId?: string; providerSlug?: { not: string } };
  }) => {
    if (args.where.retiresAt) return Promise.resolve(rows.filter((r) => r.retiresAt !== null));
    return Promise.resolve(
      rows.filter(
        (r) => r.modelId === args.where.modelId && r.providerSlug !== args.where.providerSlug?.not
      )
    );
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrchestrationSettings).mockResolvedValue(SETTINGS as never);
  vi.mocked(providerModelUsage).mockResolvedValue(UNUSED);
  catalogue([]);
});

describe('modelUses', () => {
  it('adds the settings pins and passes the scope through', async () => {
    vi.mocked(getOrchestrationSettings).mockResolvedValue({
      ...SETTINGS,
      defaultModels: { ...SETTINGS.defaultModels, chat: 'gpt-4o' },
      defaultModelsStored: { chat: 'gpt-4o' },
    } as never);

    const uses = await modelUses(
      { id: 'm1', providerSlug: 'openai', modelId: 'gpt-4o' },
      { acrossOrgs: false }
    );

    expect(providerModelUsage).toHaveBeenCalledWith('openai', 'gpt-4o', { acrossOrgs: false });
    expect(uses).toEqual({
      ...UNUSED,
      settings: [{ slot: 'chat', source: 'saved', byIdOnly: true }],
      sharedWith: [],
    });
  });

  it('names the other providers that offer the same id, giving both rows the bare-id use', async () => {
    catalogue([
      { id: 'o', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: null },
      { id: 'a', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: null },
    ]);
    vi.mocked(getOrchestrationSettings).mockResolvedValue({
      ...SETTINGS,
      defaultModels: { ...SETTINGS.defaultModels, chat: 'gpt-4o' },
    } as never);

    const uses = await modelUses({ id: 'a', providerSlug: 'microsoft', modelId: 'gpt-4o' });

    expect(uses.sharedWith).toEqual(['openai']);
    expect(uses.settings).toEqual([{ slot: 'chat', source: 'suggested', byIdOnly: true }]);
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
    expect(isInUse({ ...UNUSED, settings: [], sharedWith: [], ...part })).toBe(true);
  });

  it('is false for nothing', () => {
    expect(isInUse({ ...UNUSED, settings: [], sharedWith: [] })).toBe(false);
  });
});

describe('retiringModelsInUse', () => {
  it('reads only models with a retirement date, and nothing else when there are none', async () => {
    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 0 });
    expect(prisma.aiProviderModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { retiresAt: { not: null } } })
    );
    expect(getOrchestrationSettings).not.toHaveBeenCalled();
  });

  it('counts each dated model in use by its state at the time given, and skips unused ones', async () => {
    catalogue([
      { id: 'r1', providerSlug: 'openai', modelId: 'retiring-used', retiresAt: FUTURE },
      { id: 'r2', providerSlug: 'openai', modelId: 'retiring-unused', retiresAt: FUTURE },
      { id: 'd1', providerSlug: 'openai', modelId: 'retired-used', retiresAt: PAST },
      { id: 'd2', providerSlug: 'openai', modelId: 'pinned-chat', retiresAt: PAST },
    ]);
    vi.mocked(getOrchestrationSettings).mockResolvedValue({
      ...SETTINGS,
      defaultModels: { ...SETTINGS.defaultModels, chat: 'pinned-chat' },
    } as never);
    vi.mocked(providerModelUsage).mockImplementation(async (_provider, modelId) =>
      modelId === 'retiring-used' || modelId === 'retired-used'
        ? { ...UNUSED, otherOrgAgents: 2 }
        : UNUSED
    );

    // `pinned-chat` is named only by a default, by id alone; nobody else
    // offers the id, so that is exactly its use.
    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 1, retired: 2 });
    // Counted across every org: no scope narrowing.
    expect(providerModelUsage).toHaveBeenCalledWith('openai', 'retiring-used');
  });

  it('does not alert on a by-id-only use while another provider offers the id undated', async () => {
    // Azure's gpt-4o is retired; OpenAI's is current. A workflow and the chat
    // default name `gpt-4o` alone and may run on OpenAI's.
    catalogue([
      { id: 'az', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: PAST },
      { id: 'oa', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: null },
    ]);
    vi.mocked(getOrchestrationSettings).mockResolvedValue({
      ...SETTINGS,
      defaultModels: { ...SETTINGS.defaultModels, chat: 'gpt-4o' },
    } as never);
    vi.mocked(providerModelUsage).mockResolvedValue({ ...UNUSED, otherOrgWorkflows: 3 });

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 0 });
  });

  it('alerts on a by-id-only use when every row with the id is dated', async () => {
    catalogue([
      { id: 'az', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: PAST },
      { id: 'oa', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: FUTURE },
    ]);
    vi.mocked(providerModelUsage).mockResolvedValue({ ...UNUSED, otherOrgWorkflows: 1 });

    // Both rows carry the workflow pin, so each alerts by its own state.
    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 1, retired: 1 });
  });

  it('still alerts on an agent, which names provider and model, whatever shares the id', async () => {
    catalogue([
      { id: 'az', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: PAST },
      { id: 'oa', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: null },
    ]);
    vi.mocked(providerModelUsage).mockImplementation(async (provider) =>
      provider === 'microsoft' ? { ...UNUSED, otherOrgAgents: 1 } : UNUSED
    );

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 1 });
  });
});
