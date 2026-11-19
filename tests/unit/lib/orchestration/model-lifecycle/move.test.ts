/**
 * Moving every use of a model to its replacement (§136 t-1066).
 *
 * The database is a small in-memory world of two orgs, and the tenancy scope
 * is a variable `runAsOrg` sets: every read and write the fakes receive
 * asserts it runs inside the org whose rows it names, so a move that read or
 * wrote across orgs fails here, not just in the smoke. A transaction restores
 * the world when its callback throws, as Postgres would.
 *
 * `repinWorkflow` is faked over the same world, calling the `rewrite` the move
 * hands it on what the world holds, so the pins the move writes are the real
 * rewrite's; its own locking and versioning are tested beside the version
 * service.
 *
 * @see lib/orchestration/model-lifecycle/move.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: { findUnique: vi.fn(), findMany: vi.fn() },
    aiProviderConfig: { findUnique: vi.fn() },
    aiOrgProviderKey: { count: vi.fn() },
    aiAgent: { findMany: vi.fn(), updateMany: vi.fn() },
    aiWorkflow: { findMany: vi.fn() },
    aiOrchestrationSettings: { findUnique: vi.fn(), update: vi.fn() },
    org: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('@/lib/tenancy/context', () => ({
  isMultiTenant: vi.fn(),
  listActiveOrgIds: vi.fn(),
  runAsOrg: vi.fn(),
}));
vi.mock('@/lib/orchestration/agents/agent-versioning', () => ({
  AGENT_BATCH_TRANSACTION_TIMEOUT_MS: 60_000,
  ensureBaselineVersion: vi.fn(),
  recordAgentVersion: vi.fn(),
  isAgentVersionConflict: vi.fn(() => false),
}));
vi.mock('@/lib/orchestration/workflows/version-service', () => ({ repinWorkflow: vi.fn() }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/lib/orchestration/llm/org-provider-keys', () => ({
  openOrgProviderKey: vi.fn(),
  describeError: (err: unknown) => (err instanceof Error ? err.name : typeof err),
}));
vi.mock('@/lib/orchestration/llm/org-provider-key-admin', () => ({
  withoutKey: (text: string, key: string) => text.split(key).join('[key]'),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ testProviderKeyOnModel: vi.fn() }));
vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock('@/lib/orchestration/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/settings')>()),
  getOrchestrationSettings: vi.fn(),
  invalidateOrchestrationSettingsCache: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { isMultiTenant, listActiveOrgIds, runAsOrg } from '@/lib/tenancy/context';
import {
  ensureBaselineVersion,
  recordAgentVersion,
} from '@/lib/orchestration/agents/agent-versioning';
import { repinWorkflow } from '@/lib/orchestration/workflows/version-service';
import { logAdminAction, type AdminAuditEntry } from '@/lib/orchestration/audit/admin-audit-logger';
import { openOrgProviderKey } from '@/lib/orchestration/llm/org-provider-keys';
import { testProviderKeyOnModel } from '@/lib/orchestration/llm/provider-manager';
import { logger } from '@/lib/logging';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import {
  loadMoveTarget,
  moveModelUses,
  previewModelMove,
  type MoveTarget,
} from '@/lib/orchestration/model-lifecycle/move';

// ── The world ───────────────────────────────────────────────────────────────

interface CatalogueRow {
  id: string;
  name: string;
  providerSlug: string;
  modelId: string;
  capabilities: string[];
  isActive: boolean;
  retiresAt: Date | null;
}

const RETIRING: CatalogueRow = {
  id: 'm-old',
  name: 'GPT-4o',
  providerSlug: 'openai',
  modelId: 'gpt-4o',
  capabilities: ['chat', 'vision'],
  isActive: true,
  retiresAt: new Date('2027-06-01T00:00:00.000Z'),
};
const REPLACEMENT: CatalogueRow = {
  id: 'm-new',
  name: 'GPT-4.1',
  providerSlug: 'openai',
  modelId: 'gpt-4.1',
  capabilities: ['chat', 'vision', 'tools'],
  isActive: true,
  retiresAt: null,
};
const OTHER_PROVIDER: CatalogueRow = {
  ...REPLACEMENT,
  id: 'm-azure',
  name: 'Azure GPT-4.1',
  providerSlug: 'microsoft',
};

interface Agent {
  id: string;
  name: string;
  orgId: string;
  provider: string;
  model: string;
  isActive: boolean;
  deletedAt: Date | null;
}

interface Workflow {
  id: string;
  name: string;
  orgId: string;
  draftDefinition: unknown;
  published: { version: number; snapshot: unknown } | null;
}

interface SettingsRow {
  defaultModels: Record<string, string>;
  confidentialModelProvider: string | null;
  confidentialModel: string | null;
}

interface World {
  catalogue: CatalogueRow[];
  orgs: Array<{ id: string; name: string; status: 'ACTIVE' | 'SUSPENDED' }>;
  agents: Agent[];
  workflows: Workflow[];
  /** Orgs with their own key for the provider row `cfg-openai`. */
  keyed: string[];
  settings: SettingsRow;
}

let world: World;
/** The org scope `runAsOrg` entered; `null` outside every one. */
let scope: string | null = null;
let multi = true;
const audit: Array<AdminAuditEntry & { scope: string | null }> = [];

function step(id: string, type: string, modelOverride?: string) {
  return {
    id,
    name: id,
    type,
    config: modelOverride === undefined ? { prompt: 'x' } : { prompt: 'x', modelOverride },
    nextSteps: [],
  };
}

function definition(...steps: unknown[]) {
  return { entryStepId: 'a', errorStrategy: 'fail', steps };
}

function overridesOf(def: unknown): Array<string | undefined> {
  const { steps } = def as { steps: Array<{ config: { modelOverride?: string } }> };
  return steps.map((s) => s.config.modelOverride);
}

function freshWorld(): World {
  return {
    catalogue: [RETIRING, REPLACEMENT, OTHER_PROVIDER],
    orgs: [
      { id: 'org-a', name: 'Acme', status: 'ACTIVE' },
      { id: 'org-b', name: 'Bolt', status: 'ACTIVE' },
      { id: 'org-c', name: 'Gone', status: 'SUSPENDED' },
    ],
    agents: [
      {
        id: 'ag-a1',
        name: 'A support',
        orgId: 'org-a',
        provider: 'openai',
        model: 'gpt-4o',
        isActive: true,
        deletedAt: null,
      },
      {
        id: 'ag-a2',
        name: 'A dormant',
        orgId: 'org-a',
        provider: 'openai',
        model: 'gpt-4o',
        isActive: false,
        deletedAt: null,
      },
      {
        id: 'ag-a3',
        name: 'A deleted',
        orgId: 'org-a',
        provider: 'openai',
        model: 'gpt-4o',
        isActive: false,
        deletedAt: new Date('2027-01-01T00:00:00.000Z'),
      },
      {
        id: 'ag-a4',
        name: 'A mini',
        orgId: 'org-a',
        provider: 'openai',
        model: 'gpt-4o-mini',
        isActive: true,
        deletedAt: null,
      },
      {
        id: 'ag-a5',
        name: 'A azure',
        orgId: 'org-a',
        provider: 'microsoft',
        model: 'gpt-4o',
        isActive: true,
        deletedAt: null,
      },
      {
        id: 'ag-b1',
        name: 'B sales',
        orgId: 'org-b',
        provider: 'openai',
        model: 'gpt-4o',
        isActive: true,
        deletedAt: null,
      },
      {
        id: 'ag-c1',
        name: 'C suspended',
        orgId: 'org-c',
        provider: 'openai',
        model: 'gpt-4o',
        isActive: true,
        deletedAt: null,
      },
    ],
    workflows: [
      {
        id: 'wf-a1',
        name: 'A pipeline',
        orgId: 'org-a',
        // The draft names it by pair, the published version by bare id and in
        // a chat_turn step, which is left.
        draftDefinition: definition(step('a', 'llm_call', 'openai::gpt-4o'), step('b', 'llm_call')),
        published: {
          version: 3,
          snapshot: definition(step('a', 'llm_call', 'gpt-4o'), step('c', 'chat_turn', 'gpt-4o')),
        },
      },
      {
        id: 'wf-a2',
        name: 'A other model',
        orgId: 'org-a',
        draftDefinition: null,
        published: {
          version: 1,
          snapshot: definition(step('a', 'llm_call', 'openai::gpt-4o-mini')),
        },
      },
      {
        id: 'wf-b1',
        name: 'B review',
        orgId: 'org-b',
        draftDefinition: null,
        published: { version: 7, snapshot: definition(step('a', 'evaluate', 'openai::gpt-4o')) },
      },
    ],
    keyed: [],
    settings: {
      defaultModels: { routing: 'openai::gpt-4o', embeddings: 'gpt-4o' },
      confidentialModelProvider: 'openai',
      confidentialModel: 'gpt-4o',
    },
  };
}

/** The scope a read or write of `orgId`'s rows must run in. */
function assertScope(orgId: string | undefined): void {
  if (!multi) {
    expect(orgId).toBeUndefined();
    return;
  }
  expect(scope).not.toBeNull();
  expect(orgId).toBe(scope);
}

function inOrgRows<T extends { orgId: string }>(rows: T[], orgId: string | undefined): T[] {
  return orgId === undefined ? rows : rows.filter((r) => r.orgId === orgId);
}

function installFakes(): void {
  vi.mocked(isMultiTenant).mockImplementation(() => multi);
  vi.mocked(listActiveOrgIds).mockImplementation(() =>
    Promise.resolve(world.orgs.filter((o) => o.status === 'ACTIVE').map((o) => o.id))
  );
  vi.mocked(runAsOrg).mockImplementation(async (orgId: string, fn: () => Promise<unknown>) => {
    const outer = scope;
    scope = orgId;
    try {
      return await fn();
    } finally {
      scope = outer;
    }
  });

  vi.mocked(prisma.aiProviderModel.findUnique).mockImplementation(((args: {
    where: { id: string };
  }) => Promise.resolve(world.catalogue.find((m) => m.id === args.where.id) ?? null)) as never);
  vi.mocked(prisma.aiProviderModel.findMany).mockImplementation(((args: {
    where: { modelId: string; providerSlug: { not: string } };
  }) =>
    Promise.resolve(
      world.catalogue.filter(
        (m) =>
          m.isActive &&
          m.modelId === args.where.modelId &&
          m.providerSlug !== args.where.providerSlug.not
      )
    )) as never);
  vi.mocked(prisma.org.findUnique).mockResolvedValue({ name: 'Install' } as never);
  vi.mocked(prisma.org.findMany).mockImplementation(((args: { where: { id: { in: string[] } } }) =>
    Promise.resolve(world.orgs.filter((o) => args.where.id.in.includes(o.id)))) as never);
  vi.mocked(prisma.org.count).mockImplementation((() =>
    Promise.resolve(world.orgs.filter((o) => o.status !== 'ACTIVE').length)) as never);
  vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue({
    id: 'cfg-openai',
    slug: 'openai',
  } as never);
  vi.mocked(prisma.aiOrgProviderKey.count).mockImplementation(((args: {
    where: { orgId: string };
  }) => {
    assertScope(args.where.orgId);
    return Promise.resolve(world.keyed.includes(args.where.orgId) ? 1 : 0);
  }) as never);

  vi.mocked(prisma.aiAgent.findMany).mockImplementation(((args: {
    where: { orgId?: string; provider: string; model: string; deletedAt: null };
  }) => {
    assertScope(args.where.orgId);
    return Promise.resolve(
      inOrgRows(world.agents, args.where.orgId).filter(
        (a) =>
          a.provider === args.where.provider && a.model === args.where.model && a.deletedAt === null
      )
    );
  }) as never);
  vi.mocked(prisma.aiWorkflow.findMany).mockImplementation(((args: {
    where: { orgId?: string };
  }) => {
    assertScope(args.where.orgId);
    return Promise.resolve(
      inOrgRows(world.workflows, args.where.orgId).map((w) => ({
        id: w.id,
        name: w.name,
        draftDefinition: w.draftDefinition,
        publishedVersion: w.published ? { snapshot: w.published.snapshot } : null,
      }))
    );
  }) as never);

  const tx = {
    aiAgent: {
      updateMany: vi.fn(
        (args: {
          where: { id: string; orgId?: string; provider: string; model: string };
          data: { model: string };
        }) => {
          assertScope(args.where.orgId);
          const hit = inOrgRows(world.agents, args.where.orgId).filter(
            (a) =>
              a.id === args.where.id &&
              a.provider === args.where.provider &&
              a.model === args.where.model &&
              a.deletedAt === null
          );
          for (const a of hit) a.model = args.data.model;
          return Promise.resolve({ count: hit.length });
        }
      ),
    },
    aiOrchestrationSettings: {
      findUnique: vi.fn(() => Promise.resolve(world.settings)),
      update: vi.fn((args: { data: Partial<SettingsRow> }) => {
        world.settings = { ...world.settings, ...args.data };
        return Promise.resolve(world.settings);
      }),
    },
  };
  vi.mocked(prisma.$transaction).mockImplementation((async (fn: (t: typeof tx) => unknown) => {
    const before = structuredClone(world);
    try {
      return await fn(tx);
    } catch (err) {
      world = before;
      throw err;
    }
  }) as never);

  vi.mocked(repinWorkflow).mockImplementation(async ({ workflowId, rewrite }) => {
    const w = world.workflows.find((x) => x.id === workflowId);
    if (!w) throw new Error('no workflow');
    assertScope(multi ? w.orgId : undefined);
    let draftChanged = false;
    if (w.draftDefinition !== null) {
      const next = rewrite(w.draftDefinition);
      if (next !== w.draftDefinition) {
        w.draftDefinition = next;
        draftChanged = true;
      }
    }
    let published: { from: number; to: number } | null = null;
    if (w.published) {
      const next = rewrite(w.published.snapshot);
      if (next !== w.published.snapshot) {
        published = { from: w.published.version, to: w.published.version + 1 };
        w.published = { version: w.published.version + 1, snapshot: next };
      }
    }
    return { draftChanged, published };
  });
  vi.mocked(recordAgentVersion).mockResolvedValue(2);
  vi.mocked(logAdminAction).mockImplementation((entry) => {
    audit.push({ ...entry, scope });
  });
  vi.mocked(openOrgProviderKey).mockImplementation(() => {
    if (scope === null) throw new Error('openOrgProviderKey outside an org');
    return Promise.resolve(
      world.keyed.includes(scope) ? { apiKey: `sk-${scope}-secret`, summary: {} as never } : null
    );
  });
  vi.mocked(testProviderKeyOnModel).mockResolvedValue({ ok: true });
  vi.mocked(getOrchestrationSettings).mockImplementation(() =>
    Promise.resolve({
      defaultModels: {
        routing: world.settings.defaultModels.routing ?? 'x',
        chat: world.settings.defaultModels.chat ?? 'gpt-4o',
        reasoning: world.settings.defaultModels.reasoning ?? 'anthropic::claude-opus',
        embeddings: world.settings.defaultModels.embeddings ?? 'x',
        audio: world.settings.defaultModels.audio ?? 'openai::whisper-1',
      },
      defaultModelsStored: world.settings.defaultModels,
      confidentialModel:
        world.settings.confidentialModelProvider && world.settings.confidentialModel
          ? {
              providerSlug: world.settings.confidentialModelProvider,
              model: world.settings.confidentialModel,
            }
          : null,
      activeEmbeddingModelId: null,
    } as never)
  );
}

const ACTOR = { userId: 'admin-1', clientIp: '203.0.113.9' };

beforeEach(() => {
  vi.clearAllMocks();
  world = freshWorld();
  scope = null;
  multi = true;
  audit.length = 0;
  installFakes();
});

function agent(id: string): Agent {
  const found = world.agents.find((a) => a.id === id);
  if (!found) throw new Error(id);
  return found;
}

function workflow(id: string): Workflow {
  const found = world.workflows.find((w) => w.id === id);
  if (!found) throw new Error(id);
  return found;
}

async function target(): Promise<MoveTarget> {
  return loadMoveTarget(RETIRING.id, REPLACEMENT.id);
}

// ── loadMoveTarget ──────────────────────────────────────────────────────────

describe('loadMoveTarget', () => {
  it('reads both rows and the providers that share the id', async () => {
    world.catalogue.push({ ...RETIRING, id: 'm-az-4o', providerSlug: 'microsoft' });
    const t = await target();
    expect(t.model.id).toBe('m-old');
    expect(t.replacement.id).toBe('m-new');
    expect(t.sharedWith).toEqual(['microsoft']);
  });

  it('refuses a replacement on another provider, naming why', async () => {
    const refused = loadMoveTarget(RETIRING.id, OTHER_PROVIDER.id);
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toMatchObject({
      message: expect.stringContaining('same provider (openai)'),
      details: { replacementId: [expect.stringContaining('microsoft')] },
    });
  });

  it('refuses a stored replacement that has stopped qualifying', async () => {
    world.catalogue[1] = { ...REPLACEMENT, retiresAt: new Date('2028-01-01') };
    await expect(target()).rejects.toMatchObject({
      message: '"GPT-4.1" is itself being retired',
    });
  });

  it('refuses a replacement that does not exist, and a model that does not', async () => {
    await expect(loadMoveTarget(RETIRING.id, 'nope')).rejects.toBeInstanceOf(ValidationError);
    await expect(loadMoveTarget('nope', REPLACEMENT.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Preview ─────────────────────────────────────────────────────────────────

describe('previewModelMove', () => {
  it('counts each active org’s uses inside that org, and changes nothing', async () => {
    world.keyed = ['org-b'];
    const preview = await previewModelMove(await target());

    expect(preview.orgs).toEqual([
      {
        orgId: 'org-a',
        name: 'Acme',
        agents: 2,
        inactiveAgents: 1,
        workflows: 1,
        left: [{ workflowId: 'wf-a1', stepId: 'c', reason: 'chat_turn_by_id' }],
        ownKey: false,
      },
      {
        orgId: 'org-b',
        name: 'Bolt',
        agents: 1,
        inactiveAgents: 0,
        workflows: 1,
        left: [],
        ownKey: true,
      },
    ]);
    expect(preview.suspendedOrgs).toBe(1);
    expect(preview.settings.moved.map((s) => s.slot)).toEqual(['routing', 'chat', 'confidential']);
    expect(preview.settings.left).toEqual([{ slot: 'embeddings', reason: 'embedding_switch' }]);
    expect(runAsOrg).toHaveBeenCalledTimes(2);

    // Nothing written, and no key tested: the test is billed to the key.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(repinWorkflow).not.toHaveBeenCalled();
    expect(testProviderKeyOnModel).not.toHaveBeenCalled();
    expect(world).toEqual({ ...freshWorld(), keyed: ['org-b'] });
  });

  it('leaves out an org with nothing to move or leave', async () => {
    world.agents = world.agents.filter((a) => a.orgId !== 'org-b');
    world.workflows = world.workflows.filter((w) => w.orgId !== 'org-b');
    const preview = await previewModelMove(await target());
    expect(preview.orgs.map((o) => o.orgId)).toEqual(['org-a']);
  });
});

// ── Move ────────────────────────────────────────────────────────────────────

describe('moveModelUses', () => {
  it('moves every org’s agents and workflows, each inside its own org, and the settings', async () => {
    const result = await moveModelUses(await target(), ACTOR);

    // Agents: the model id changes, the provider stays; deleted, other-model
    // and other-provider agents are untouched; the suspended org is not entered.
    expect(agent('ag-a1')).toMatchObject({ provider: 'openai', model: 'gpt-4.1' });
    expect(agent('ag-a2').model).toBe('gpt-4.1');
    expect(agent('ag-b1').model).toBe('gpt-4.1');
    expect(agent('ag-a3').model).toBe('gpt-4o');
    expect(agent('ag-a4').model).toBe('gpt-4o-mini');
    expect(agent('ag-a5')).toMatchObject({ provider: 'microsoft', model: 'gpt-4o' });
    expect(agent('ag-c1').model).toBe('gpt-4o');
    // Each moved agent was given a baseline and a new version.
    expect(vi.mocked(recordAgentVersion).mock.calls.map((c) => c[1])).toEqual([
      'ag-a1',
      'ag-a2',
      'ag-b1',
    ]);
    expect(ensureBaselineVersion).toHaveBeenCalledTimes(3);
    expect(vi.mocked(recordAgentVersion).mock.calls[0][2]).toEqual({
      label: 'Model gpt-4o moved to gpt-4.1 (retiring model)',
      createdBy: 'admin-1',
    });

    // Workflows: pairs written in the draft and a new published version; the
    // chat_turn bare id left; another model's workflow untouched.
    expect(overridesOf(workflow('wf-a1').draftDefinition)).toEqual(['openai::gpt-4.1', undefined]);
    expect(workflow('wf-a1').published).toEqual({
      version: 4,
      snapshot: definition(
        step('a', 'llm_call', 'openai::gpt-4.1'),
        step('c', 'chat_turn', 'gpt-4o')
      ),
    });
    expect(workflow('wf-b1').published?.version).toBe(8);
    expect(overridesOf(workflow('wf-b1').published?.snapshot)).toEqual(['openai::gpt-4.1']);
    expect(workflow('wf-a2').published?.version).toBe(1);

    // Settings: the saved routing pair, the suggested chat default saved, the
    // confidential model; the embeddings default left.
    expect(world.settings).toEqual({
      defaultModels: { routing: 'openai::gpt-4.1', chat: 'openai::gpt-4.1', embeddings: 'gpt-4o' },
      confidentialModelProvider: 'openai',
      confidentialModel: 'gpt-4.1',
    });

    expect(result.orgs).toEqual([
      {
        orgId: 'org-a',
        name: 'Acme',
        status: 'moved',
        agents: 2,
        workflows: 1,
        left: [{ workflowId: 'wf-a1', stepId: 'c', reason: 'chat_turn_by_id' }],
      },
      { orgId: 'org-b', name: 'Bolt', status: 'moved', agents: 1, workflows: 1, left: [] },
    ]);
    expect(result.totals).toEqual({ agents: 3, workflows: 2, settings: 3, skipped: 0, failed: 0 });
    expect(result.suspendedOrgs).toBe(1);
  });

  it('writes a row per changed entity in its org, one for the settings and a summary', async () => {
    await moveModelUses(await target(), ACTOR);
    const rows = audit.map((r) => [r.action, r.entityId, r.scope]);
    expect(rows).toEqual([
      ['agent.model_moved', 'ag-a1', 'org-a'],
      ['agent.model_moved', 'ag-a2', 'org-a'],
      ['workflow.model_moved', 'wf-a1', 'org-a'],
      ['agent.model_moved', 'ag-b1', 'org-b'],
      ['workflow.model_moved', 'wf-b1', 'org-b'],
      ['settings.model_moved', 'global', null],
      ['provider_model.uses_moved', 'm-old', null],
    ]);
    expect(audit[0]).toMatchObject({
      userId: 'admin-1',
      clientIp: '203.0.113.9',
      changes: { model: { from: 'gpt-4o', to: 'gpt-4.1' } },
      metadata: { providerModelId: 'm-old', replacementId: 'm-new', version: 2 },
    });
    expect(audit[2]).toMatchObject({
      changes: { publishedVersion: { from: 3, to: 4 } },
      metadata: { draftChanged: true },
    });
    expect(audit[5].changes).toEqual({
      routing: { from: 'openai::gpt-4o', to: 'openai::gpt-4.1' },
      chat: { from: 'gpt-4o', to: 'openai::gpt-4.1' },
      confidential: { from: 'gpt-4o', to: 'gpt-4.1' },
    });
    expect(audit[6].metadata).toMatchObject({
      replacementId: 'm-new',
      agents: 3,
      workflows: 2,
      settings: 3,
      skipped: 0,
      failed: 0,
      suspendedOrgs: 1,
      skippedOrgs: [],
    });
  });

  it('skips exactly the org whose own key fails its test against the replacement', async () => {
    world.keyed = ['org-b'];
    vi.mocked(testProviderKeyOnModel).mockResolvedValue({
      ok: false,
      failedAt: 'model',
      error: 'model not allowed for key sk-org-b-secret',
    });
    const result = await moveModelUses(await target(), ACTOR);

    // Tested once, with B's key, against the replacement, as a chat model.
    expect(testProviderKeyOnModel).toHaveBeenCalledTimes(1);
    expect(testProviderKeyOnModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cfg-openai' }),
      'sk-org-b-secret',
      'gpt-4.1',
      { chat: true }
    );
    expect(agent('ag-b1').model).toBe('gpt-4o');
    expect(workflow('wf-b1').published?.version).toBe(7);
    expect(agent('ag-a1').model).toBe('gpt-4.1');
    expect(result.orgs.map((o) => [o.orgId, o.status])).toEqual([
      ['org-a', 'moved'],
      ['org-b', 'skipped'],
    ]);
    const skipped = result.orgs[1];
    expect(skipped.reason).toBe(
      'Its own key for this provider could not use GPT-4.1 (a test message to it failed).'
    );
    expect(result.totals.skipped).toBe(1);
    // The key appears in no answer, and the log has it cut out.
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(vi.mocked(logger.warn).mock.calls[0][1]).toMatchObject({
      orgId: 'org-b',
      detail: 'model not allowed for key [key]',
    });
    expect(audit.at(-1)?.metadata).toMatchObject({
      skippedOrgs: [{ orgId: 'org-b', status: 'skipped', reason: skipped.reason }],
    });
  });

  it('skips an org whose key the vendor refuses, or that will not open', async () => {
    world.keyed = ['org-a', 'org-b'];
    vi.mocked(testProviderKeyOnModel).mockResolvedValue({ ok: false, failedAt: 'key' });
    vi.mocked(openOrgProviderKey).mockImplementation(() =>
      Promise.resolve(
        scope === 'org-a'
          ? { apiKey: null, summary: {} as never }
          : { apiKey: 'sk-b', summary: {} as never }
      )
    );
    const result = await moveModelUses(await target(), ACTOR);
    expect(result.orgs.map((o) => [o.orgId, o.status, o.reason])).toEqual([
      [
        'org-a',
        'skipped',
        'Its own key for this provider cannot be opened, so it could not be tested against the replacement.',
      ],
      ['org-b', 'skipped', 'The provider refused its own key for this provider.'],
    ]);
    expect(world.agents).toEqual(freshWorld().agents);
  });

  it('tests the key alone, with no message, when the replacement is not a chat model', async () => {
    world.keyed = ['org-a'];
    world.catalogue = world.catalogue.map((m) => ({ ...m, capabilities: ['embedding'] }));
    await moveModelUses(await target(), ACTOR);
    expect(vi.mocked(testProviderKeyOnModel).mock.calls[0][3]).toEqual({ chat: false });
  });

  it('rolls back an org that fails, reports it, and still moves the others', async () => {
    vi.mocked(repinWorkflow).mockImplementationOnce(() => {
      throw new Error('relation "ai_workflow" violates something secret');
    });
    const result = await moveModelUses(await target(), ACTOR);

    // A's agents were written before its workflow failed: rolled back with it.
    expect(agent('ag-a1').model).toBe('gpt-4o');
    expect(workflow('wf-a1').published?.version).toBe(3);
    expect(agent('ag-b1').model).toBe('gpt-4.1');
    expect(result.orgs[0]).toMatchObject({
      orgId: 'org-a',
      status: 'failed',
      reason: 'Its changes could not be written. Nothing in it moved.',
      agents: 0,
      workflows: 0,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.totals.failed).toBe(1);
    // No audit row for what was rolled back.
    expect(audit.filter((r) => r.scope === 'org-a')).toEqual([]);
  });

  it('reports a validation failure in an org in its own words', async () => {
    vi.mocked(repinWorkflow).mockImplementationOnce(() => {
      throw new ValidationError('The published workflow is structurally invalid');
    });
    const result = await moveModelUses(await target(), ACTOR);
    expect(result.orgs[0].reason).toBe('The published workflow is structurally invalid');
  });

  it('leaves pins naming the id alone when another provider offers it', async () => {
    world.catalogue.push({ ...RETIRING, id: 'm-az-4o', providerSlug: 'microsoft' });
    const result = await moveModelUses(await target(), ACTOR);
    // The bare llm_call in A's published version stays; the draft's pair moves.
    expect(overridesOf(workflow('wf-a1').published?.snapshot)).toEqual(['gpt-4o', 'gpt-4o']);
    expect(overridesOf(workflow('wf-a1').draftDefinition)).toEqual(['openai::gpt-4.1', undefined]);
    expect(result.orgs[0].left).toEqual([
      { workflowId: 'wf-a1', stepId: 'a', reason: 'shared_id' },
      { workflowId: 'wf-a1', stepId: 'c', reason: 'chat_turn_by_id' },
    ]);
    // The suggested chat default names the id alone too.
    expect(world.settings.defaultModels.chat).toBeUndefined();
    expect(result.settings.left).toContainEqual({ slot: 'chat', reason: 'shared_id' });
  });

  it('does not version or audit an agent moved off the model since it was read', async () => {
    const realUpdate = vi.mocked(prisma.$transaction).getMockImplementation();
    vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: never, opts: never) => {
      agent('ag-a2').model = 'gpt-4o-mini'; // an editor's save lands first
      return realUpdate?.(fn, opts);
    }) as never);
    const result = await moveModelUses(await target(), ACTOR);
    expect(agent('ag-a2').model).toBe('gpt-4o-mini');
    expect(result.orgs[0].agents).toBe(1);
    expect(audit.map((r) => r.entityId)).not.toContain('ag-a2');
  });

  it('leaves a settings slot someone changed since the plan was made', async () => {
    vi.mocked(getOrchestrationSettings).mockResolvedValueOnce({
      defaultModels: {
        routing: 'openai::gpt-4o',
        chat: 'x',
        reasoning: 'x',
        embeddings: 'x',
        audio: 'x',
      },
      defaultModelsStored: { routing: 'openai::gpt-4o' },
      confidentialModel: null,
      activeEmbeddingModelId: null,
    } as never);
    // Saved since: the transaction reads routing as something else.
    world.settings.defaultModels.routing = 'anthropic::claude-sonnet';
    const result = await moveModelUses(await target(), ACTOR);
    expect(world.settings.defaultModels.routing).toBe('anthropic::claude-sonnet');
    expect(result.settings.moved).toEqual([]);
    expect(audit.map((r) => r.action)).not.toContain('settings.model_moved');
  });

  it('at single, walks the install once, with no org scope, filter or key test', async () => {
    multi = false;
    world.keyed = ['org-a'];
    const result = await moveModelUses(await target(), ACTOR);
    expect(runAsOrg).not.toHaveBeenCalled();
    expect(testProviderKeyOnModel).not.toHaveBeenCalled();
    expect(result.orgs).toHaveLength(1);
    expect(result.orgs[0]).toMatchObject({ orgId: 'install', name: 'Install', status: 'moved' });
    // Every row is the install's at single, the suspended org's included.
    expect(agent('ag-c1').model).toBe('gpt-4.1');
    expect(result.suspendedOrgs).toBe(0);
  });
});
