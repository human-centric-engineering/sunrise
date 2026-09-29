/**
 * Tests: reconcilePlatformAgents — one test per `fp4` property (§116 t-724).
 *
 * Driven against an in-memory stand-in for the handful of delegates the
 * reconcile touches, not against call-shaped mocks: the properties are about
 * the STATE a run leaves behind and the writes it does or does not make, and
 * a mock that answers whatever it is asked cannot say whether a second run
 * wrote nothing. The stand-in stamps every created row with the org the REAL
 * tenant context holds at that moment, which is what makes "upserts by
 * (orgId, slug) inside the org's own scope" checkable at all.
 *
 * Each property was confirmed to fail when its implementation is removed
 * (noted per test).
 *
 * @see lib/orchestration/agents/reconcile-platform-agents.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import type { PlatformAgentDefinition } from '@/lib/orchestration/agents/platform-agents';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockClearCache = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: { clearCache: mockClearCache },
}));
const mockInvalidateAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/knowledge/resolveAgentDocumentAccess', () => ({
  invalidateAgentAccess: mockInvalidateAccess,
}));

/** The registry the reconcile sees; `null` means "the real one". */
const registry = vi.hoisted(() => ({ definitions: null as PlatformAgentDefinition[] | null }));
vi.mock('@/lib/orchestration/agents/platform-agents', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/orchestration/agents/platform-agents')>();
  return {
    ...actual,
    platformAgentsForOrg: (orgId: string) =>
      registry.definitions === null
        ? actual.platformAgentsForOrg(orgId)
        : registry.definitions.filter((d) => d.audience === 'every-org' || orgId === 'install'),
    getPlatformAgent: (slug: string) =>
      registry.definitions === null
        ? actual.getPlatformAgent(slug)
        : registry.definitions.find((d) => d.slug === slug),
    platformAgentRegistryHash: () =>
      registry.definitions === null
        ? actual.platformAgentRegistryHash()
        : `test-${JSON.stringify(registry.definitions.map(({ defaultBinding: _binding, ...d }) => d))}`,
  };
});

// ─── The in-memory stand-in ────────────────────────────────────────────────

const fake = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const state = {
    seq: 0,
    orgs: new Map<string, { id: string; settings: unknown }>(),
    agents: [] as Row[],
    bindings: [] as Row[],
    tagGrants: [] as Row[],
    docGrants: [] as Row[],
    versions: [] as Row[],
    capabilities: [] as Array<{ id: string; slug: string }>,
    tags: [] as Array<{ id: string; slug: string }>,
    providers: [] as Array<{ slug: string; isLocal: boolean; apiKeyEnvVar: string | null }>,
    models: [] as Array<Record<string, unknown>>,
    /** Every mutating call, in order: `model.method`. */
    writes: [] as string[],
    failOn: null as string | null,
    orgOf: () => 'install' as string,
  };
  const id = (p: string) => `${p}-${++state.seq}`;
  const write = (name: string) => {
    state.writes.push(name);
    if (state.failOn === name) throw new Error(`injected failure in ${name}`);
  };
  const unjson = (v: unknown) => (v === Prisma.JsonNull ? null : v);
  const inList = (where: { id?: { in: string[] } }, row: Row) =>
    !where.id || where.id.in.includes(row.id);

  const AGENT_DEFAULTS = {
    fallbackProviders: [],
    providerConfig: null,
    monthlyBudgetUsd: null,
    maxCostPerTurnUsd: null,
    rateLimitRpm: null,
    retentionDays: null,
    systemInstructionsHistory: [],
    deletedAt: null,
    lastActiveAt: null,
    isSystem: false,
  };

  const db = {
    user: { findFirst: async () => ({ id: 'service-account' }) },
    org: {
      findUnique: async ({ where }: { where: { id: string } }) => state.orgs.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { settings: unknown } }) => {
        write('org.update');
        const org = state.orgs.get(where.id)!;
        org.settings = data.settings;
        return org;
      },
    },
    aiAgent: {
      findMany: async ({ where }: { where: { orgId: string; slug: { in: string[] } } }) =>
        state.agents
          .filter((a) => a.orgId === where.orgId && where.slug.in.includes(a.slug as string))
          .map((a) => ({
            ...a,
            capabilities: state.bindings
              .filter((b) => b.agentId === a.id)
              .map((b) => ({ id: b.id, capabilityId: b.capabilityId, isEnabled: b.isEnabled })),
            grantedTags: state.tagGrants
              .filter((g) => g.agentId === a.id)
              .map((g) => ({ tagId: g.tagId })),
            grantedDocuments: state.docGrants
              .filter((g) => g.agentId === a.id)
              .map((g) => ({ documentId: g.documentId })),
          })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        write('aiAgent.create');
        const row: Row = {
          ...AGENT_DEFAULTS,
          ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, unjson(v)])),
          id: id('agent'),
          orgId: state.orgOf(),
          updatedAt: state.seq,
        };
        state.agents.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        write('aiAgent.update');
        const row = state.agents.find((a) => a.id === where.id)!;
        for (const [k, v] of Object.entries(data)) row[k] = unjson(v);
        row.updatedAt = ++state.seq;
        return row;
      },
    },
    aiCapability: {
      findMany: async ({ where }: { where: { slug: { in: string[] } } }) =>
        state.capabilities.filter((c) => where.slug.in.includes(c.slug)),
    },
    knowledgeTag: {
      findMany: async ({ where }: { where: { slug: { in: string[] } } }) =>
        state.tags.filter((t) => where.slug.in.includes(t.slug)),
    },
    aiAgentCapability: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        write('aiAgentCapability.createMany');
        for (const d of data)
          state.bindings.push({ ...d, id: id('binding'), orgId: state.orgOf() });
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        write('aiAgentCapability.deleteMany');
        state.bindings = state.bindings.filter((b) => !inList(where, b));
        return { count: 0 };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        write('aiAgentCapability.updateMany');
        for (const b of state.bindings) if (inList(where, b)) Object.assign(b, data);
        return { count: 0 };
      },
    },
    aiAgentKnowledgeTag: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        write('aiAgentKnowledgeTag.createMany');
        for (const d of data) state.tagGrants.push({ ...d, id: id('tg'), orgId: state.orgOf() });
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: { agentId: string } }) => {
        write('aiAgentKnowledgeTag.deleteMany');
        state.tagGrants = state.tagGrants.filter((g) => g.agentId !== where.agentId);
        return { count: 0 };
      },
    },
    aiAgentKnowledgeDocument: {
      deleteMany: async ({ where }: { where: { agentId: string } }) => {
        write('aiAgentKnowledgeDocument.deleteMany');
        state.docGrants = state.docGrants.filter((g) => g.agentId !== where.agentId);
        return { count: 0 };
      },
    },
    aiAgentVersion: {
      findFirst: async ({ where }: { where: { agentId: string } }) => {
        const mine = state.versions.filter((v) => v.agentId === where.agentId);
        return mine.length === 0
          ? null
          : { version: Math.max(...mine.map((v) => v.version as number)) };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        write('aiAgentVersion.create');
        const row = { ...data, id: id('version'), orgId: state.orgOf() };
        state.versions.push(row);
        return row;
      },
    },
    aiProviderConfig: { findMany: async () => state.providers },
    aiProviderModel: { findMany: async () => state.models },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { state, db };
});

vi.mock('@/lib/db/client', () => ({ prisma: fake.db }));

/**
 * The patterns-knowledge step (t-726), which has its own tests (`seeder.test.ts`):
 * here only its place in the run matters. It records the scope and client it
 * was called with, and — like the real one on an org's first copy — creates
 * the tag if it is missing.
 */
const knowledge = vi.hoisted(() => ({
  calls: [] as Array<{ orgId: string | null | undefined; db: unknown }>,
  outcome: 'present',
  error: null as Error | null,
  createsTag: null as { id: string; slug: string } | null,
}));
vi.mock('@/lib/orchestration/knowledge/seeder', async () => {
  const { getTenantContext: context } = await import('@/lib/tenancy/context');
  return {
    loadPatternsChunks: async () => [],
    materialisePatternsKnowledge: async (_chunks: unknown, options?: { db?: unknown }) => {
      knowledge.calls.push({ orgId: context()?.orgId, db: options?.db });
      if (knowledge.error) throw knowledge.error;
      const tag = knowledge.createsTag;
      if (tag && !fake.state.tags.some((t) => t.slug === tag.slug)) fake.state.tags.push(tag);
      return { outcome: knowledge.outcome, documentId: 'doc-patterns' };
    },
  };
});

import {
  reconcilePlatformAgents,
  reconcilePlatformAgentsIfStale,
} from '@/lib/orchestration/agents/reconcile-platform-agents';
import {
  CORE_PLATFORM_AGENTS,
  PLATFORM_AGENT_BASELINE,
} from '@/lib/orchestration/agents/platform-agents';
import { platformAgentFieldNames } from '@/lib/orchestration/agents/agent-field-registry';
import { PATTERNS_TAG_SLUG } from '@/lib/orchestration/knowledge/patterns-knowledge';
import { getTenantContext } from '@/lib/tenancy/context';

const ORG_B = 'cmorg00000000000000000orgb';

function definition(
  slug: string,
  overrides: Partial<PlatformAgentDefinition> = {}
): PlatformAgentDefinition {
  return {
    slug,
    audience: 'every-org',
    agent: {
      name: `Agent ${slug}`,
      description: `The ${slug} agent`,
      systemInstructions: `You are ${slug}.`,
      temperature: 0.2,
      maxTokens: 1000,
    },
    capabilities: ['search_knowledge_base'],
    knowledgeTags: [PATTERNS_TAG_SLUG],
    ...overrides,
  };
}

function agent(slug: string, orgId = 'install') {
  return fake.state.agents.find((a) => a.slug === slug && a.orgId === orgId);
}

function marker(orgId = 'install') {
  const settings = fake.state.orgs.get(orgId)?.settings as
    { platformAgents?: { hash: string; slugs: string[] } } | undefined;
  return settings?.platformAgents;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  const s = fake.state;
  s.seq = 0;
  s.orgs = new Map([
    ['install', { id: 'install', settings: { forkConfig: { keep: true } } }],
    [ORG_B, { id: ORG_B, settings: null }],
  ]);
  s.agents = [];
  s.bindings = [];
  s.tagGrants = [];
  s.docGrants = [];
  s.versions = [];
  s.capabilities = [
    { id: 'cap-search', slug: 'search_knowledge_base' },
    { id: 'cap-detail', slug: 'get_pattern_detail' },
  ];
  s.tags = [{ id: 'tag-patterns', slug: PATTERNS_TAG_SLUG }];
  s.providers = [];
  s.models = [];
  s.writes = [];
  s.failOn = null;
  // The org the data layer would stamp: whatever the REAL context holds.
  s.orgOf = () => getTenantContext()?.orgId ?? 'NO-CONTEXT';
  registry.definitions = [definition('advisor'), definition('judge')];
  knowledge.calls = [];
  knowledge.outcome = 'present';
  knowledge.error = null;
  knowledge.createsTag = null;
});

describe('reconcilePlatformAgents', () => {
  it('creates each instance in the org, as the service account, with bindings, grants and a v1', async () => {
    mockEnv.TENANCY_MODE = 'multi';

    const result = await reconcilePlatformAgents(ORG_B);

    expect(result.created).toEqual(['advisor', 'judge']);
    const row = agent('advisor', ORG_B)!;
    // Stamped with ORG_B by the scope the reconcile entered for itself — the
    // test never entered one. Removing the runAsOrg fails this with NO-CONTEXT.
    expect(row).toMatchObject({
      orgId: ORG_B,
      isSystem: true,
      createdBy: 'service-account',
      name: 'Agent advisor',
      provider: '',
      model: '',
      ...PLATFORM_AGENT_BASELINE,
    });
    expect(fake.state.bindings.filter((b) => b.agentId === row.id)).toEqual([
      expect.objectContaining({ capabilityId: 'cap-search', isEnabled: true, orgId: ORG_B }),
    ]);
    expect(fake.state.tagGrants.filter((g) => g.agentId === row.id)).toEqual([
      expect.objectContaining({ tagId: 'tag-patterns', orgId: ORG_B }),
    ]);
    expect(fake.state.versions.filter((v) => v.agentId === row.id)).toEqual([
      expect.objectContaining({
        version: 1,
        changeSummary: 'Initial configuration',
        createdBy: 'service-account',
      }),
    ]);
    expect(marker(ORG_B)).toEqual({ hash: expect.any(String), slugs: ['advisor', 'judge'] });
  });

  it('is idempotent: a second run writes nothing at all', async () => {
    await reconcilePlatformAgents('install');
    expect(fake.state.writes.length).toBeGreaterThan(0); // the first run did write
    fake.state.writes = [];
    mockClearCache.mockClear();

    const second = await reconcilePlatformAgents('install');

    // Fails if the field comparison, the binding diff, or the marker's
    // "unchanged" check is removed — each turns into a write here.
    expect(second).toMatchObject({ created: [], updated: [], unchanged: ['advisor', 'judge'] });
    expect(fake.state.writes).toEqual([]);
    expect(mockClearCache).not.toHaveBeenCalled(); // test-review:accept no_arg_called — no binding changed, so no eviction
  });

  it('preserves every other key in Org.settings when it writes the marker', async () => {
    await reconcilePlatformAgents('install');

    expect(fake.state.orgs.get('install')!.settings).toEqual({
      forkConfig: { keep: true },
      platformAgents: { hash: expect.any(String), slugs: ['advisor', 'judge'] },
    });
  });

  it('is safe on an empty registry: creates nothing and deactivates nothing it placed', async () => {
    await reconcilePlatformAgents('install');
    const before = marker();
    registry.definitions = [];
    fake.state.writes = [];

    const result = await reconcilePlatformAgents('install');

    // Without the empty guard both placed agents are switched off here.
    expect(result.deactivated).toEqual([]);
    expect(fake.state.writes).toEqual([]);
    expect(agent('advisor')?.isActive).toBe(true);
    expect(marker()).toEqual(before);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(/resolved empty/),
      expect.objectContaining({ placedBefore: ['advisor', 'judge'] })
    );
  });

  it('writes code-owned fields back and never touches org-tunable ones', async () => {
    await reconcilePlatformAgents('install');
    const row = agent('advisor')!;
    // An org's edits: two code-owned (what it is), four org-tunable (how it runs).
    Object.assign(row, {
      name: 'Renamed',
      persona: 'a pirate',
      provider: 'openai',
      model: 'gpt-4.1',
      monthlyBudgetUsd: 5,
      retentionDays: 30,
    });

    const result = await reconcilePlatformAgents('install');

    expect(result.updated).toEqual(['advisor']);
    expect(row).toMatchObject({
      name: 'Agent advisor',
      persona: null, // back to the baseline, though the definition never set it
      provider: 'openai',
      model: 'gpt-4.1',
      monthlyBudgetUsd: 5,
      retentionDays: 30,
    });
  });

  it('covers exactly the code-owned fields — no more, no fewer', () => {
    // The reconcile writes BASELINE ∪ the definition's fields. If that set and
    // the field registry's code-owned list drift apart, a field is either
    // never reconciled or reconciled against the org's will.
    const written = new Set([
      ...Object.keys(PLATFORM_AGENT_BASELINE),
      'name',
      'description',
      'systemInstructions',
      'temperature',
      'maxTokens',
      'slug',
    ]);
    const codeOwnedScalars = platformAgentFieldNames('code').filter(
      (f) => f !== 'grantedTagIds' && f !== 'grantedDocumentIds'
    );
    expect([...written].sort()).toEqual([...codeOwnedScalars].sort());
  });

  it('sets bindings and grants to the declared set', async () => {
    await reconcilePlatformAgents('install');
    const row = agent('advisor')!;
    fake.state.bindings.find((b) => b.agentId === row.id)!.isEnabled = false;
    fake.state.bindings.push({
      id: 'stray',
      agentId: row.id,
      capabilityId: 'cap-detail',
      isEnabled: true,
    });
    fake.state.tagGrants = fake.state.tagGrants.filter((g) => g.agentId !== row.id);
    fake.state.docGrants.push({ id: 'dg', agentId: row.id, documentId: 'doc-1' });

    await reconcilePlatformAgents('install');

    expect(fake.state.bindings.filter((b) => b.agentId === row.id)).toEqual([
      expect.objectContaining({ capabilityId: 'cap-search', isEnabled: true }),
    ]);
    expect(fake.state.tagGrants.filter((g) => g.agentId === row.id)).toEqual([
      expect.objectContaining({ tagId: 'tag-patterns' }),
    ]);
    expect(fake.state.docGrants).toEqual([]);
    expect(mockClearCache).toHaveBeenCalled();
    expect(mockInvalidateAccess).toHaveBeenCalledWith(row.id);
  });

  it('leaves every binding row alone on an agent whose bindings are the org’s', async () => {
    registry.definitions = [
      definition('dispatcher', { capabilities: [], capabilityBindings: 'org' }),
    ];
    await reconcilePlatformAgents('install');
    const row = agent('dispatcher')!;
    // The operator's grants: one enabled, one switched off.
    fake.state.bindings.push(
      { id: 'granted', agentId: row.id, capabilityId: 'cap-search', isEnabled: true },
      { id: 'revoked', agentId: row.id, capabilityId: 'cap-detail', isEnabled: false }
    );
    fake.state.writes = [];

    const result = await reconcilePlatformAgents('install');

    expect(result.unchanged).toEqual(['dispatcher']);
    expect(fake.state.writes).toEqual([]);
    expect(fake.state.bindings.filter((b) => b.agentId === row.id)).toEqual([
      expect.objectContaining({ id: 'granted', isEnabled: true }),
      expect.objectContaining({ id: 'revoked', isEnabled: false }),
    ]);
  });

  it('writes a version row for a code-owned change, and none for anything else', async () => {
    await reconcilePlatformAgents('install');
    const row = agent('advisor')!;
    const versionsOf = () => fake.state.versions.filter((v) => v.agentId === row.id);

    // An org-tunable difference only: nothing for the reconcile to change.
    row.provider = 'anthropic';
    await reconcilePlatformAgents('install');
    expect(versionsOf()).toHaveLength(1);

    // A binding-only change: written, but bindings are not in the snapshot.
    fake.state.bindings = fake.state.bindings.filter((b) => b.agentId !== row.id);
    await reconcilePlatformAgents('install');
    expect(versionsOf()).toHaveLength(1);

    // A code-owned change: a new version holding the post-change config.
    row.temperature = 0.9;
    await reconcilePlatformAgents('install');
    expect(versionsOf()).toHaveLength(2);
    expect(versionsOf()[1]).toMatchObject({
      version: 2,
      createdBy: 'service-account',
      changeSummary: expect.stringMatching(/^Platform definition: .*Temperature/),
      snapshot: expect.objectContaining({ temperature: 0.2, provider: 'anthropic' }),
    });
  });

  it('keeps a legacy agent’s pre-change config as v1 before versioning the change', async () => {
    // An install-org agent a pre-§116 seed wrote with no version history.
    fake.state.agents.push({
      id: 'legacy',
      orgId: 'install',
      slug: 'advisor',
      isSystem: true,
      deletedAt: null,
      provider: '',
      model: '',
      ...PLATFORM_AGENT_BASELINE,
      name: 'Agent advisor',
      description: 'The advisor agent',
      systemInstructions: 'An older prompt.',
      temperature: 0.2,
      maxTokens: 1000,
    });

    await reconcilePlatformAgents('install');

    const versions = fake.state.versions.filter((v) => v.agentId === 'legacy');
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]).toMatchObject({
      changeSummary: 'Initial configuration',
      snapshot: expect.objectContaining({ systemInstructions: 'An older prompt.' }),
    });
    expect(versions[1].snapshot).toMatchObject({ systemInstructions: 'You are advisor.' });
  });

  it('refuses to adopt an org’s own agent that holds a platform slug', async () => {
    fake.state.agents.push({
      id: 'theirs',
      orgId: 'install',
      slug: 'advisor',
      isSystem: false,
      deletedAt: null,
      name: 'Our advisor',
      systemInstructions: 'Our own prompt.',
    });

    const result = await reconcilePlatformAgents('install');

    // Without the isSystem check, this row is overwritten and adopted.
    expect(result.refused).toEqual([{ slug: 'advisor', reason: 'tenant-agent' }]);
    expect(agent('advisor')).toMatchObject({
      isSystem: false,
      name: 'Our advisor',
      systemInstructions: 'Our own prompt.',
    });
    expect(fake.state.bindings.some((b) => b.agentId === 'theirs')).toBe(false);
    expect(marker()!.slugs).toEqual(['judge']);
  });

  it('deactivates, never deletes, an agent dropped from the registry — only one it placed', async () => {
    await reconcilePlatformAgents('install');
    // A fork's own seeded system agent the reconcile never placed.
    fake.state.agents.push({
      id: 'fork-system',
      orgId: 'install',
      slug: 'fork-helper',
      isSystem: true,
      isActive: true,
      deletedAt: null,
    });
    registry.definitions = [definition('advisor')];

    const result = await reconcilePlatformAgents('install');

    expect(result.deactivated).toEqual(['judge']);
    expect(agent('judge')).toMatchObject({ isActive: false }); // still there
    expect(agent('fork-helper')).toMatchObject({ isActive: true });
    expect(fake.state.versions.filter((v) => v.agentId === agent('judge')!.id)).toEqual([
      expect.anything(),
      expect.objectContaining({ changeSummary: 'Removed from the platform agent registry' }),
    ]);
    // Still the platform's: kept in the marker while its row exists.
    expect(marker()!.slugs).toEqual(['advisor', 'judge']);
  });

  it('switches a retired agent off again if it was turned back on', async () => {
    await reconcilePlatformAgents('install');
    registry.definitions = [definition('advisor')];
    await reconcilePlatformAgents('install');
    // An org admin re-enables it — the PATCH route allows isActive:true on a
    // system agent — and a later release reconciles the org again.
    agent('judge')!.isActive = true;
    registry.definitions = [
      definition('advisor', { agent: { ...definition('advisor').agent, temperature: 0.5 } }),
    ];

    const result = await reconcilePlatformAgents('install');

    expect(result.deactivated).toEqual(['judge']);
    expect(agent('judge')!.isActive).toBe(false);
  });

  it('reactivates an agent put back in the registry', async () => {
    await reconcilePlatformAgents('install');
    registry.definitions = [definition('advisor')];
    await reconcilePlatformAgents('install');
    registry.definitions = [definition('advisor'), definition('judge')];

    await reconcilePlatformAgents('install');

    expect(agent('judge')).toMatchObject({ isActive: true });
  });

  it('deactivates, never deletes, an agent in an org once it turns install-only', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    await reconcilePlatformAgents(ORG_B);
    const placed = agent('advisor', ORG_B)!;
    expect(placed.isActive).toBe(true);
    registry.definitions = [
      definition('advisor', { audience: 'install-only' }),
      definition('judge'),
    ];

    const result = await reconcilePlatformAgents(ORG_B);

    expect(result.deactivated).toEqual(['advisor']);
    expect(agent('advisor', ORG_B)).toBe(placed); // same row, still there
    expect(placed.isActive).toBe(false);
    // Still registered, so its history says why honestly: not "removed".
    expect(fake.state.versions.filter((v) => v.agentId === placed.id).at(-1)?.changeSummary).toBe(
      'No longer one of this org’s platform agents (its audience changed)'
    );
    expect(agent('judge', ORG_B)?.isActive).toBe(true);
    // Kept in the marker, so every later reconcile keeps it switched off.
    expect(marker(ORG_B)?.slugs).toEqual(['advisor', 'judge']);
  });

  it('puts install-only agents into the install org only', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    registry.definitions = [
      definition('advisor'),
      definition('auditor', { audience: 'install-only' }),
    ];

    await reconcilePlatformAgents('install');
    await reconcilePlatformAgents(ORG_B);

    expect(agent('auditor', 'install')).toBeDefined();
    expect(agent('auditor', ORG_B)).toBeUndefined();
    expect(agent('advisor', ORG_B)).toBeDefined();
  });

  it('at single, reconciles the install org only', async () => {
    const result = await reconcilePlatformAgents(ORG_B);

    expect(result.skipped).toBe('single-tenant-non-install-org');
    expect(fake.state.writes).toEqual([]);
    expect(knowledge.calls).toEqual([]);
  });

  describe('the patterns knowledge (t-726)', () => {
    it('writes no copy in an org none of whose agents declares the patterns tag (t-733)', async () => {
      mockEnv.TENANCY_MODE = 'multi';
      registry.definitions = [
        definition('advisor', { audience: 'install-only' }),
        definition('judge', { knowledgeTags: [] }),
      ];

      const other = await reconcilePlatformAgents(ORG_B);
      const install = await reconcilePlatformAgents('install');

      expect(other.knowledge).toBeUndefined();
      expect(install.knowledge).toBe('present');
      expect(knowledge.calls.map((c) => c.orgId)).toEqual(['install']);
      // Nothing is missing for B, so its marker is written as usual.
      expect(marker(ORG_B)).toEqual({ hash: expect.any(String), slugs: ['judge'] });
    });

    it('writes a copy in any org one of whose agents declares the tag — a fork’s included', async () => {
      mockEnv.TENANCY_MODE = 'multi';
      registry.definitions = [definition('fork-tutor', { knowledgeTags: [PATTERNS_TAG_SLUG] })];

      const result = await reconcilePlatformAgents(ORG_B);

      expect(result.knowledge).toBe('present');
      expect(knowledge.calls).toEqual([{ orgId: ORG_B, db: fake.db }]);
    });

    it('writes the org’s copy in its own scope, before the tags are read, so its tag is granted on the same run', async () => {
      mockEnv.TENANCY_MODE = 'multi';
      fake.state.tags = []; // a new install: no tag until the first copy exists
      knowledge.createsTag = { id: 'tag-patterns', slug: PATTERNS_TAG_SLUG };
      knowledge.outcome = 'created';

      const result = await reconcilePlatformAgents(ORG_B);

      expect(result.knowledge).toBe('created');
      expect(knowledge.calls).toEqual([{ orgId: ORG_B, db: fake.db }]);
      // Called after the tag lookup instead, the tag is missing on this run:
      // no grants, and no marker.
      expect(result.missing.knowledgeTags).toEqual([]);
      expect(fake.state.tagGrants.filter((g) => g.orgId === ORG_B)).toHaveLength(2);
      expect(marker(ORG_B)).toBeDefined();
    });

    it('writes through the client the caller passed', async () => {
      const own = { ...fake.db };

      await reconcilePlatformAgents('install', { db: own as never });

      expect(knowledge.calls[0]?.db).toBe(own);
    });

    it('reconciles the agents anyway when the copy fails, and holds the marker back until it is written', async () => {
      knowledge.error = new Error('chunk file unreadable');

      const result = await reconcilePlatformAgents('install');

      expect(result.knowledge).toBe('failed');
      expect(result.created).toEqual(['advisor', 'judge']);
      expect(marker()).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringMatching(/Patterns knowledge not written/),
        expect.objectContaining({ orgId: 'install', error: 'chunk file unreadable' })
      );

      knowledge.error = null;
      const next = await reconcilePlatformAgentsIfStale('install');

      expect(next.reconciled).toBe(true);
      expect(next.result?.knowledge).toBe('present');
      expect(marker()).toBeDefined();
    });

    it('records the marker when the org holds an earlier copy: it is left, not retried', async () => {
      knowledge.outcome = 'outdated';

      const result = await reconcilePlatformAgents('install');

      expect(result.knowledge).toBe('outdated');
      expect(marker()).toBeDefined();
    });
  });

  it('skips a declared capability or tag with no row yet, and says so', async () => {
    fake.state.tags = [];

    const result = await reconcilePlatformAgents('install');

    expect(result.missing).toEqual({ capabilities: [], knowledgeTags: [PATTERNS_TAG_SLUG] });
    expect(fake.state.tagGrants).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('leaves the marker unwritten while anything declared is missing, and grants it once it exists', async () => {
    fake.state.tags = [];
    await reconcilePlatformAgents('install');
    // No digest recorded: the job will come back for this org.
    expect(marker()).toBeUndefined();

    fake.state.tags = [{ id: 'tag-patterns', slug: PATTERNS_TAG_SLUG }];
    const outcome = await reconcilePlatformAgentsIfStale('install');

    expect(outcome.reconciled).toBe(true);
    expect(fake.state.tagGrants).toHaveLength(2);
    expect(marker()).toBeDefined();
  });

  it('treats a create that lost a race as done, and leaves the marker for the next run', async () => {
    // Another run created `advisor` between this run's read and its write.
    const realCreate = fake.db.aiAgent.create;
    fake.db.aiAgent.create = async (args: { data: Record<string, unknown> }) => {
      if (args.data.slug === 'advisor') {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      return realCreate(args);
    };
    try {
      const result = await reconcilePlatformAgents('install');

      expect(result.created).toEqual(['judge']);
      expect(result.unchanged).toEqual(['advisor']);
      expect(marker()).toBeUndefined();
    } finally {
      fake.db.aiAgent.create = realCreate;
    }
  });

  it('treats an update or deactivation that lost a version-number race as done', async () => {
    await reconcilePlatformAgents('install');
    agent('advisor')!.temperature = 0.9; // needs an update, with a version row
    registry.definitions = [definition('advisor')]; // and judge needs deactivating
    const realCreate = fake.db.aiAgentVersion.create;
    // Another run numbered the same version first, for both agents.
    fake.db.aiAgentVersion.create = async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    };
    const before = marker();
    try {
      const result = await reconcilePlatformAgents('install');

      expect(result.updated).toEqual([]);
      expect(result.deactivated).toEqual([]);
      expect(result.unchanged).toEqual(['advisor']);
      // Left for the next run to record.
      expect(marker()).toEqual(before);
    } finally {
      fake.db.aiAgentVersion.create = realCreate;
    }
  });

  it('keeps a legacy agent’s active config as v1 before recording its removal', async () => {
    await reconcilePlatformAgents('install');
    const judgeId = agent('judge')!.id;
    // A legacy row with no history (the old seed order left cleanup-agent so).
    fake.state.versions = fake.state.versions.filter((v) => v.agentId !== judgeId);
    registry.definitions = [definition('advisor')];

    await reconcilePlatformAgents('install');

    const versions = fake.state.versions.filter((v) => v.agentId === judgeId);
    expect(versions.map((v) => [v.version, v.changeSummary])).toEqual([
      [1, 'Initial configuration'],
      [2, 'Removed from the platform agent registry'],
    ]);
    expect(versions[0].snapshot).toMatchObject({ isActive: true });
    expect(versions[1].snapshot).toMatchObject({ isActive: false });
  });

  it('still fails on any other create error', async () => {
    fake.state.failOn = 'aiAgent.create';

    await expect(reconcilePlatformAgents('install')).rejects.toThrow(/injected failure/);
  });

  it('does not store the marker when a write fails, so the job runs it again', async () => {
    fake.state.failOn = 'aiAgentVersion.create';

    await expect(reconcilePlatformAgents('install')).rejects.toThrow(/injected failure/);

    expect(marker()).toBeUndefined();
  });

  describe('a default binding', () => {
    const withPin = () =>
      definition('advisor', {
        defaultBinding: async () => ({ provider: 'openai', model: 'gpt-4.1' }),
      });

    it('is pinned on create, and filled later only while provider and model are both empty', async () => {
      registry.definitions = [withPin()];
      await reconcilePlatformAgents('install');
      expect(agent('advisor')).toMatchObject({ provider: 'openai', model: 'gpt-4.1' });

      // The org chose its own: never overwritten.
      Object.assign(agent('advisor')!, { provider: 'anthropic', model: 'claude' });
      await reconcilePlatformAgents('install');
      expect(agent('advisor')).toMatchObject({ provider: 'anthropic', model: 'claude' });

      // Back to "inherit": filled again.
      Object.assign(agent('advisor')!, { provider: '', model: '' });
      await reconcilePlatformAgents('install');
      expect(agent('advisor')).toMatchObject({ provider: 'openai', model: 'gpt-4.1' });
    });

    it('applies the definition’s org-tunable defaults on create only', async () => {
      registry.definitions = [definition('advisor', { defaults: { monthlyBudgetUsd: 25 } })];
      await reconcilePlatformAgents('install');
      expect(agent('advisor')!.monthlyBudgetUsd).toBe(25);

      agent('advisor')!.monthlyBudgetUsd = 3;
      await reconcilePlatformAgents('install');
      expect(agent('advisor')!.monthlyBudgetUsd).toBe(3);
    });
  });

  it('materialises the real registry: 12 agents per org, 16 in the install org', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    registry.definitions = null;
    fake.state.capabilities = [];
    fake.state.tags = [];

    const install = await reconcilePlatformAgents('install');
    const other = await reconcilePlatformAgents(ORG_B);

    expect(install.created).toHaveLength(CORE_PLATFORM_AGENTS.length);
    expect(install.created).toHaveLength(16);
    expect(other.created).toHaveLength(12);
    for (const slug of [
      'provider-model-auditor',
      'audit-report-writer',
      'pattern-advisor',
      'quiz-master',
    ]) {
      expect(other.created).not.toContain(slug);
    }
    // The patterns knowledge follows its agents (t-733): the install org's only.
    expect(install.knowledge).toBe('present');
    expect(other.knowledge).toBeUndefined();
    expect(knowledge.calls.map((c) => c.orgId)).toEqual(['install']);
  });
});

describe('reconcilePlatformAgentsIfStale', () => {
  it('reconciles an org with no marker, then leaves it alone while the digest matches', async () => {
    expect(await reconcilePlatformAgentsIfStale('install')).toMatchObject({ reconciled: true });
    fake.state.writes = [];

    expect(await reconcilePlatformAgentsIfStale('install')).toEqual({ reconciled: false });
    expect(fake.state.writes).toEqual([]);
  });

  it('reconciles again when the registry changes', async () => {
    await reconcilePlatformAgentsIfStale('install');
    registry.definitions = [definition('advisor'), definition('judge'), definition('quiz')];

    const outcome = await reconcilePlatformAgentsIfStale('install');

    expect(outcome).toMatchObject({ reconciled: true, result: { created: ['quiz'] } });
  });

  it('at single, never reconciles a non-install org', async () => {
    expect(await reconcilePlatformAgentsIfStale(ORG_B)).toEqual({ reconciled: false });
  });
});
