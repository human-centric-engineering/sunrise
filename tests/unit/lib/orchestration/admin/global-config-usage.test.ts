/**
 * Tests: lib/orchestration/admin/global-config-usage.ts (§107 t-731)
 *
 * What is pinned: at `multi` every read runs under the system scope (so
 * another org's rows count), only the entered org's rows come back by name
 * and the rest as a number, and with no org entered none are named; at
 * `single` no system scope is entered and every row is the caller's. The policy itself is proven by the two-org
 * smoke against Postgres.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockMode = vi.hoisted(() => ({ value: 'multi' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'TENANCY_MODE' ? mockMode.value : (Reflect.get(target, key) as unknown),
    }),
  };
});

const scopes = vi.hoisted(() => ({ seen: [] as Array<string | undefined> }));
const db = vi.hoisted(() => ({
  aiAgent: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  aiCostLog: { count: vi.fn() },
  aiWorkflow: { findMany: vi.fn() },
  aiAgentKnowledgeTag: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  aiKnowledgeDocumentTag: { count: vi.fn(), groupBy: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  agentProfileUsage,
  knowledgeTagCounts,
  knowledgeTagUsage,
  MAX_NAMED_TAG_AGENTS,
  providerModelUsage,
  providerUsage,
} from '@/lib/orchestration/admin/global-config-usage';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';

const ORG_A = 'cmorg0000000000000000orga';
const ORG_B = 'cmorg0000000000000000orgb';

/** A mock that records the scope it ran in, then answers `value`. */
function answering<T>(value: T) {
  return async () => {
    scopes.seen.push(getTenantContext()?.source);
    return value;
  };
}

function agent(id: string, orgId: string | null) {
  return { id, name: `Agent ${id}`, slug: `agent-${id}`, orgId };
}

function workflow(id: string, orgId: string | null, pins: 'draft' | 'published' | 'none') {
  const def = (modelId: string) => ({
    steps: [{ id: 's', type: 'llm_call', config: { modelOverride: modelId } }],
  });
  return {
    id,
    name: `Workflow ${id}`,
    slug: `wf-${id}`,
    orgId,
    draftDefinition: pins === 'draft' ? def('gpt-x') : def('other'),
    publishedVersion: pins === 'published' ? { snapshot: def('gpt-x') } : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  scopes.seen = [];
  mockMode.value = 'multi';
});
afterEach(() => {
  mockMode.value = 'multi';
});

describe('providerUsage', () => {
  it('counts primary, fallback and cost references, each under the system scope', async () => {
    db.aiAgent.count.mockImplementationOnce(answering(2)).mockImplementationOnce(answering(1));
    db.aiCostLog.count.mockImplementation(answering(7));

    const usage = await runAsOrg(ORG_A, () => providerUsage('openai'));

    expect(usage).toEqual({ primaryAgents: 2, fallbackAgents: 1, costLogRows: 7 });
    expect(scopes.seen).toEqual(['system', 'system', 'system']);
    expect(db.aiAgent.count).toHaveBeenCalledWith({ where: { provider: 'openai' } });
    expect(db.aiAgent.count).toHaveBeenCalledWith({
      where: { fallbackProviders: { has: 'openai' } },
    });
    expect(db.aiCostLog.count).toHaveBeenCalledWith({ where: { provider: 'openai' } });
  });
});

describe('providerModelUsage', () => {
  beforeEach(() => {
    db.aiAgent.findMany.mockImplementation(
      answering([agent('a1', ORG_A), agent('b1', ORG_B), agent('b2', ORG_B)])
    );
    db.aiWorkflow.findMany.mockImplementation(
      answering([
        workflow('wa', ORG_A, 'published'),
        workflow('wb', ORG_B, 'draft'),
        workflow('wn', ORG_A, 'none'),
      ])
    );
  });

  it('names the entered org’s agents and workflows, and counts the other org’s', async () => {
    const usage = await runAsOrg(ORG_A, () => providerModelUsage('openai', 'gpt-x'));

    expect(usage).toEqual({
      agents: [{ id: 'a1', name: 'Agent a1', slug: 'agent-a1' }],
      workflows: [{ id: 'wa', name: 'Workflow wa', slug: 'wf-wa' }],
      otherOrgAgents: 2,
      otherOrgWorkflows: 1,
    });
    expect(scopes.seen).toEqual(['system', 'system']);
    expect(db.aiAgent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, provider: 'openai', model: 'gpt-x' } })
    );
  });

  it('names nothing with no org entered (an admin API key), and counts it all', async () => {
    const usage = await providerModelUsage('openai', 'gpt-x');

    expect(usage.agents).toEqual([]);
    expect(usage.workflows).toEqual([]);
    expect(usage.otherOrgAgents).toBe(3);
    expect(usage.otherOrgWorkflows).toBe(2);
  });

  it('treats every row as the caller’s at single, NULL-org rows included', async () => {
    mockMode.value = 'single';
    db.aiAgent.findMany.mockImplementation(answering([agent('a1', ORG_A), agent('n1', null)]));

    const usage = await providerModelUsage('openai', 'gpt-x');

    expect(usage.agents.map((a) => a.id)).toEqual(['a1', 'n1']);
    expect(usage.otherOrgAgents).toBe(0);
    expect(usage.otherOrgWorkflows).toBe(0);
  });

  it('counts a model pinned through a supervisor step', async () => {
    db.aiWorkflow.findMany.mockImplementation(
      answering([
        {
          ...workflow('ws', ORG_B, 'none'),
          draftDefinition: {
            steps: [{ id: 's', type: 'supervisor', config: { modelOverride: 'gpt-x' } }],
          },
        },
      ])
    );

    const usage = await runAsOrg(ORG_A, () => providerModelUsage('openai', 'gpt-x'));

    expect(usage.otherOrgWorkflows).toBe(1);
  });

  it('ignores a step type that does not pin a model, and a malformed definition', async () => {
    db.aiWorkflow.findMany.mockImplementation(
      answering([
        {
          ...workflow('wt', ORG_A, 'none'),
          draftDefinition: {
            steps: [
              { id: 't', type: 'tool_call', config: { modelOverride: 'gpt-x' } },
              null,
              { id: 'n', type: 'llm_call' },
            ],
          },
        },
        { ...workflow('wm', ORG_A, 'none'), draftDefinition: { steps: 'nope' } },
        { ...workflow('wz', ORG_A, 'none'), draftDefinition: null },
      ])
    );

    const usage = await runAsOrg(ORG_A, () => providerModelUsage('openai', 'gpt-x'));

    expect(usage.workflows).toEqual([]);
    expect(usage.otherOrgWorkflows).toBe(0);
  });
});

describe('knowledgeTagUsage', () => {
  /** Grant and link counts: every org's, then the filtered (caller's) one. */
  function counts(grants: [number, number], links: [number, number]) {
    db.aiAgentKnowledgeTag.count
      .mockImplementationOnce(answering(grants[0]))
      .mockImplementationOnce(answering(grants[1]));
    db.aiKnowledgeDocumentTag.count
      .mockImplementationOnce(answering(links[0]))
      .mockImplementationOnce(answering(links[1]));
  }

  it('counts grants and document links in every org, naming only the entered org’s agents', async () => {
    counts([3, 1], [6, 1]);
    db.aiAgentKnowledgeTag.findMany.mockImplementation(
      answering([{ agent: { id: 'a1', name: 'Agent a1', slug: 'agent-a1' } }])
    );

    const usage = await runAsOrg(ORG_A, () => knowledgeTagUsage('tag-1'));

    expect(usage).toEqual({
      agentGrants: 3,
      documentLinks: 6,
      agents: [{ id: 'a1', name: 'Agent a1', slug: 'agent-a1' }],
      otherOrgAgentGrants: 2,
      otherOrgDocumentLinks: 5,
    });
    expect(scopes.seen).toEqual(['system', 'system', 'system', 'system', 'system']);
    expect(db.aiAgentKnowledgeTag.count).toHaveBeenCalledWith({ where: { tagId: 'tag-1' } });
    expect(db.aiAgentKnowledgeTag.count).toHaveBeenCalledWith({
      where: { tagId: 'tag-1', orgId: ORG_A },
    });
    expect(db.aiKnowledgeDocumentTag.count).toHaveBeenCalledWith({
      where: { tagId: 'tag-1', orgId: ORG_A },
    });
    expect(db.aiAgentKnowledgeTag.findMany).toHaveBeenCalledWith({
      where: { tagId: 'tag-1', orgId: ORG_A },
      select: { agent: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: 'asc' },
      take: MAX_NAMED_TAG_AGENTS,
    });
  });

  it('names nothing and counts it all as elsewhere with no org entered', async () => {
    db.aiAgentKnowledgeTag.count.mockImplementationOnce(answering(2));
    db.aiKnowledgeDocumentTag.count.mockImplementationOnce(answering(4));

    const usage = await knowledgeTagUsage('tag-1');

    expect(usage).toEqual({
      agentGrants: 2,
      documentLinks: 4,
      agents: [],
      otherOrgAgentGrants: 2,
      otherOrgDocumentLinks: 4,
    });
    expect(db.aiAgentKnowledgeTag.findMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — no org, so no row is the caller's to name
  });

  it('at single, reads without the system scope and treats every row as the caller’s', async () => {
    mockMode.value = 'single';
    counts([2, 2], [1, 1]);
    db.aiAgentKnowledgeTag.findMany.mockImplementation(answering([]));

    const usage = await knowledgeTagUsage('tag-1');

    expect(usage.otherOrgAgentGrants).toBe(0);
    expect(usage.otherOrgDocumentLinks).toBe(0);
    expect(scopes.seen).not.toContain('system');
    expect(db.aiAgentKnowledgeTag.count).toHaveBeenCalledWith({ where: { tagId: 'tag-1' } });
    expect(db.aiAgentKnowledgeTag.count).toHaveBeenCalledTimes(2);
  });
});

describe('knowledgeTagCounts', () => {
  it('groups every org’s grants and links by tag, under the system scope', async () => {
    db.aiAgentKnowledgeTag.groupBy.mockImplementation(
      answering([{ tagId: 't1', _count: { _all: 2 } }])
    );
    db.aiKnowledgeDocumentTag.groupBy.mockImplementation(
      answering([
        { tagId: 't1', _count: { _all: 5 } },
        { tagId: 't2', _count: { _all: 1 } },
      ])
    );

    const counts = await runAsOrg(ORG_A, () => knowledgeTagCounts(['t1', 't2', 't3']));

    expect([...counts]).toEqual([
      ['t1', { agents: 2, documents: 5 }],
      ['t2', { agents: 0, documents: 1 }],
    ]);
    expect(scopes.seen).toEqual(['system', 'system']);
    expect(db.aiAgentKnowledgeTag.groupBy).toHaveBeenCalledWith({
      by: ['tagId'],
      where: { tagId: { in: ['t1', 't2', 't3'] } },
      _count: { _all: true },
    });
  });

  it('reads nothing for no tags', async () => {
    expect([...(await knowledgeTagCounts([]))]).toEqual([]);
    expect(db.aiAgentKnowledgeTag.groupBy).not.toHaveBeenCalled(); // test-review:accept no_arg_called — an empty page needs no query
  });
});

describe('agentProfileUsage', () => {
  it('maps each profile to its attached agents in every org, under the system scope', async () => {
    db.aiAgent.groupBy.mockImplementation(
      answering([
        { profileId: 'p1', _count: { _all: 3 } },
        { profileId: null, _count: { _all: 9 } },
      ])
    );

    const counts = await runAsOrg(ORG_A, () => agentProfileUsage(['p1', 'p2']));

    expect([...counts]).toEqual([['p1', 3]]);
    expect(scopes.seen).toEqual(['system']);
    expect(db.aiAgent.groupBy).toHaveBeenCalledWith({
      by: ['profileId'],
      where: { profileId: { in: ['p1', 'p2'] } },
      _count: { _all: true },
    });
  });

  it('reads nothing for no profiles', async () => {
    expect([...(await agentProfileUsage([]))]).toEqual([]);
    expect(db.aiAgent.groupBy).not.toHaveBeenCalled(); // test-review:accept no_arg_called — an empty page needs no query
  });
});
