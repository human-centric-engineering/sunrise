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
vi.mock('@/lib/tenancy/context', () => ({
  isMultiTenant: vi.fn(() => false),
  getTenantContext: vi.fn(),
  listActiveOrgIds: vi.fn(),
  runAsOrg: vi.fn((_orgId: string, fn: () => Promise<unknown>) => fn()),
}));

import { prisma } from '@/lib/db/client';
import { providerModelUsage } from '@/lib/orchestration/admin/global-config-usage';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { modelUses, retiringModelsInUse } from '@/lib/orchestration/model-lifecycle/uses';
import {
  __resetAppModelPinsForTests,
  registerModelPinReporter,
} from '@/lib/orchestration/model-lifecycle/app-pins';
import { getTenantContext, isMultiTenant, listActiveOrgIds } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const NOW = new Date('2027-03-01T12:00:00.000Z');
const FUTURE = new Date('2027-06-01T00:00:00.000Z');
const PAST = new Date('2027-01-01T00:00:00.000Z');

const UNUSED = {
  agents: [],
  workflows: [],
  otherOrgAgents: 0,
  otherOrgAgentsFollowingPlatform: 0,
  otherOrgWorkflows: 0,
  otherOrgWorkflowsByIdOnly: 0,
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
  isActive?: boolean;
}

/**
 * The catalogue `findMany` answers from: the dated-model read
 * (`retiresAt: { not: null }`) and the same-id read (`modelId` on other
 * providers).
 */
function catalogue(rows: Row[]) {
  vi.mocked(prisma.aiProviderModel.findMany).mockImplementation(((args: {
    where: {
      retiresAt?: unknown;
      modelId?: string;
      providerSlug?: { not: string };
      isActive?: boolean;
    };
  }) => {
    if (args.where.retiresAt) return Promise.resolve(rows.filter((r) => r.retiresAt !== null));
    return Promise.resolve(
      rows.filter(
        (r) =>
          r.modelId === args.where.modelId &&
          r.providerSlug !== args.where.providerSlug?.not &&
          (args.where.isActive === undefined || (r.isActive ?? true) === args.where.isActive)
      )
    );
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrchestrationSettings).mockResolvedValue(SETTINGS as never);
  vi.mocked(providerModelUsage).mockResolvedValue(UNUSED);
  catalogue([]);
  vi.mocked(isMultiTenant).mockReturnValue(false);
  vi.mocked(getTenantContext).mockReturnValue(undefined as never);
  // tests/setup.ts pins lib/app/model-pins.ts empty; tests register here.
  __resetAppModelPinsForTests();
});

describe('modelUses', () => {
  it('adds the settings pins and passes the scope through', async () => {
    vi.mocked(getOrchestrationSettings).mockResolvedValue({
      ...SETTINGS,
      defaultModels: { ...SETTINGS.defaultModels, chat: 'gpt-4o' },
      defaultModelsStored: { chat: 'gpt-4o' },
    } as never);

    const uses = await modelUses(
      { id: 'm1', name: 'GPT-4o', providerSlug: 'openai', modelId: 'gpt-4o' },
      { acrossOrgs: false }
    );

    expect(providerModelUsage).toHaveBeenCalledWith('openai', 'gpt-4o', { acrossOrgs: false });
    expect(uses).toEqual({
      ...UNUSED,
      settings: [{ slot: 'chat', source: 'saved', byIdOnly: true }],
      sharedWith: [],
      // Nothing registered at lib/app/model-pins.ts: no app uses, none missing.
      appPins: [],
      otherOrgAppPins: 0,
      appPinsUnavailable: false,
    });
  });

  it("gives a default naming its provider to that provider's row alone", async () => {
    catalogue([
      { id: 'o', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: null },
      { id: 'a', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: null },
    ]);
    vi.mocked(getOrchestrationSettings).mockResolvedValue({
      ...SETTINGS,
      defaultModels: { ...SETTINGS.defaultModels, chat: 'microsoft::gpt-4o' },
      defaultModelsStored: { chat: 'microsoft::gpt-4o' },
    } as never);

    const azure = await modelUses({
      id: 'a',
      name: 'GPT-4o',
      providerSlug: 'microsoft',
      modelId: 'gpt-4o',
    });
    const openai = await modelUses({
      id: 'o',
      name: 'GPT-4o',
      providerSlug: 'openai',
      modelId: 'gpt-4o',
    });

    expect(azure.settings).toEqual([{ slot: 'chat', source: 'saved' }]);
    expect(openai.settings).toEqual([]);
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

    const uses = await modelUses({
      id: 'a',
      name: 'GPT-4o',
      providerSlug: 'microsoft',
      modelId: 'gpt-4o',
    });

    expect(uses.sharedWith).toEqual(['openai']);
    expect(uses.settings).toEqual([{ slot: 'chat', source: 'suggested', byIdOnly: true }]);
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
    vi.mocked(providerModelUsage).mockResolvedValue({
      ...UNUSED,
      otherOrgWorkflows: 3,
      otherOrgWorkflowsByIdOnly: 3,
    });

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 0 });
  });

  it('alerts on a by-id-only use at the least severe state of the rows with the id', async () => {
    // One retired, one still retiring: the pin may run on the retiring one,
    // which works, so it is a warning, not a critical.
    catalogue([
      { id: 'az', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: PAST },
      { id: 'oa', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: FUTURE },
    ]);
    vi.mocked(providerModelUsage).mockResolvedValue({
      ...UNUSED,
      otherOrgWorkflows: 1,
      otherOrgWorkflowsByIdOnly: 1,
    });

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 2, retired: 0 });
  });

  it('is critical for a by-id-only use only when every row with the id is retired', async () => {
    catalogue([
      { id: 'az', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: PAST },
      { id: 'oa', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: PAST },
    ]);
    vi.mocked(providerModelUsage).mockResolvedValue({
      ...UNUSED,
      otherOrgWorkflows: 1,
      otherOrgWorkflowsByIdOnly: 1,
    });

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 2 });
  });

  it('ignores a turned-off row with the id, which the runtime cannot reach (the Azure row the seed ships)', async () => {
    // Azure's gpt-4o ships turned off; OpenAI's is retired. The pin runs on
    // OpenAI's, so it must alert.
    catalogue([
      { id: 'oa', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: PAST },
      { id: 'az', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: null, isActive: false },
    ]);
    vi.mocked(providerModelUsage).mockResolvedValue({
      ...UNUSED,
      otherOrgWorkflows: 1,
      otherOrgWorkflowsByIdOnly: 1,
    });

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 1 });
  });

  it('alerts on a workflow pinning provider and model, whatever shares the id', async () => {
    catalogue([
      { id: 'az', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: PAST },
      { id: 'oa', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: null },
    ]);
    // Azure's row: one workflow in another org pins `microsoft::gpt-4o`.
    vi.mocked(providerModelUsage).mockImplementation(async (provider) =>
      provider === 'microsoft' ? { ...UNUSED, otherOrgWorkflows: 1 } : UNUSED
    );

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 1 });
  });

  it("alerts on the caller's own workflow pinning the pair, not on one pinning the id alone", async () => {
    catalogue([
      { id: 'az', providerSlug: 'microsoft', modelId: 'gpt-4o', retiresAt: PAST },
      { id: 'oa', providerSlug: 'openai', modelId: 'gpt-4o', retiresAt: null },
    ]);
    const workflow = (byIdOnly: boolean) => ({ id: 'w', name: 'W', slug: 'w', byIdOnly });

    vi.mocked(providerModelUsage).mockResolvedValue({ ...UNUSED, workflows: [workflow(true)] });
    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 0 });

    vi.mocked(providerModelUsage).mockResolvedValue({ ...UNUSED, workflows: [workflow(false)] });
    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 1 });
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

describe('the app’s own pins (§136 t-1067)', () => {
  const MODEL = { id: 'm1', name: 'GPT-4o', providerSlug: 'openai', modelId: 'gpt-4o' };

  it('names the caller’s org’s pins and counts every other org’s, at multi', async () => {
    vi.mocked(isMultiTenant).mockReturnValue(true);
    vi.mocked(getTenantContext).mockReturnValue({ orgId: 'org-a' } as never);
    vi.mocked(listActiveOrgIds).mockResolvedValue(['org-a', 'org-b']);
    registerModelPinReporter(({ orgId, model }) =>
      model.id === 'm1'
        ? orgId === 'org-a'
          ? [{ label: 'Panel: Contracts', where: 'Panels › Judge' }]
          : [
              { label: 'Panel: Claims', where: 'Panels › Judge' },
              { label: 'Panel: Leases', where: 'Panels › Judge' },
            ]
        : []
    );

    const uses = await modelUses(MODEL);

    expect(uses.appPins).toEqual([{ label: 'Panel: Contracts', where: 'Panels › Judge' }]);
    expect(uses.otherOrgAppPins).toBe(2);
    expect(uses.appPinsUnavailable).toBe(false);
  });

  it('asks the caller’s org alone when not counting across orgs', async () => {
    vi.mocked(isMultiTenant).mockReturnValue(true);
    vi.mocked(getTenantContext).mockReturnValue({ orgId: 'org-b' } as never);
    const asked: string[] = [];
    registerModelPinReporter(({ orgId }) => {
      asked.push(orgId);
      return [{ label: 'Panel', where: 'x' }];
    });

    const uses = await modelUses(MODEL, { acrossOrgs: false });

    expect(asked).toEqual(['org-b']);
    expect(listActiveOrgIds).not.toHaveBeenCalled();
    expect(uses.appPins).toHaveLength(1);
    expect(uses.otherOrgAppPins).toBe(0);
  });

  it('names every pin at single, and says when the report failed', async () => {
    registerModelPinReporter(({ orgId }) => {
      expect(orgId).toBe(INSTALL_ORG_ID);
      throw new Error('panel table missing');
    });

    const uses = await modelUses(MODEL);

    expect(uses.appPins).toEqual([]);
    expect(uses.appPinsUnavailable).toBe(true);
  });

  it('counts a dated model as in use when the app’s report about it failed', async () => {
    catalogue([{ id: 'd1', providerSlug: 'openai', modelId: 'app-maybe', retiresAt: PAST }]);
    registerModelPinReporter(() => {
      throw new Error('panel table missing');
    });

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 0, retired: 1 });
  });

  it('does not ask the app about a dated model the platform already uses', async () => {
    catalogue([{ id: 'r1', providerSlug: 'openai', modelId: 'used', retiresAt: FUTURE }]);
    vi.mocked(providerModelUsage).mockResolvedValue({ ...UNUSED, otherOrgAgents: 1 });
    const reporter = vi.fn(() => []);
    registerModelPinReporter(reporter);

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 1, retired: 0 });
    expect(reporter).not.toHaveBeenCalled();
  });

  it('counts a dated model the app alone uses as in use, by its state', async () => {
    catalogue([
      { id: 'r1', providerSlug: 'openai', modelId: 'app-only', retiresAt: FUTURE },
      { id: 'd1', providerSlug: 'openai', modelId: 'unused', retiresAt: PAST },
    ]);
    registerModelPinReporter(({ model }) =>
      model.id === 'r1' ? [{ label: 'Panel: Contracts', where: 'Panels › Judge' }] : []
    );

    expect(await retiringModelsInUse(NOW)).toEqual({ retiring: 1, retired: 0 });
  });
});
