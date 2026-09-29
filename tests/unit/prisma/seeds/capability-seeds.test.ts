/**
 * Tests: the capability seeds that used to create agents too (§116 t-724).
 *
 * `005-pattern-advisor`, `008-mcp-server` and `010-model-auditor` created the
 * pattern advisor, the MCP identity, the provider auditor and the report
 * writer as well as their capabilities and config.
 * The agents are platform agents now (`021-platform-agents`); these units
 * seed only what is still theirs, and the contract pinned here is that they
 * write no agent and no binding, while still re-applying each capability's
 * code-owned fields and (010) versioning the audit workflow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SeedContext } from '@/prisma/runner';

const mockCreateInitialVersion = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/workflows/version-service', () => ({
  createInitialVersion: mockCreateInitialVersion,
}));

import patternAdvisorSeed, { CAPABILITY_DEFINITIONS } from '@/prisma/seeds/005-pattern-advisor';
import modelAuditorSeed from '@/prisma/seeds/010-model-auditor';
import mcpServerSeed from '@/prisma/seeds/008-mcp-server';
import { serviceAccountWhere } from '@/lib/auth/account';

function makeCtx({ owner = true, existingWorkflow = null as null | { id: string } } = {}) {
  const calls: string[] = [];
  const record =
    (name: string, value: unknown = { id: `${name}-1` }) =>
    (...args: unknown[]) => {
      calls.push(name);
      return Promise.resolve(typeof value === 'function' ? value(...args) : value);
    };
  const tx = {
    aiWorkflow: {
      findUnique: vi.fn(record('aiWorkflow.findUnique', existingWorkflow)),
      create: vi.fn(record('aiWorkflow.create', { id: 'wf-1' })),
      update: vi.fn(record('aiWorkflow.update')),
    },
    aiWorkflowVersion: {
      findFirst: vi.fn(record('aiWorkflowVersion.findFirst', { version: 3 })),
      create: vi.fn(record('aiWorkflowVersion.create', { id: 'v-4' })),
    },
  };
  const prisma = {
    user: { findFirst: vi.fn(record('user.findFirst', owner ? { id: 'service-1' } : null)) },
    aiCapability: { upsert: vi.fn(record('aiCapability.upsert')) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { ctx: { prisma, logger } as unknown as SeedContext, prisma, tx, calls };
}

beforeEach(() => vi.clearAllMocks());

/** The upsert argument a capability seed passed, typed for the assertions. */
interface CapabilityUpsert {
  where: { slug: string };
  update: Record<string, unknown>;
}
const upserts = (fn: { mock: { calls: unknown[][] } }): CapabilityUpsert[] =>
  fn.mock.calls.map((c) => c[0] as CapabilityUpsert);

describe('005-pattern-advisor', () => {
  it('upserts its three capabilities, re-applying only the code-owned fields, and nothing else', async () => {
    const { ctx, prisma, calls } = makeCtx();

    await patternAdvisorSeed.run(ctx);

    // Only capability writes: a stand-in with no aiAgent delegate would have
    // thrown on any agent or binding write.
    expect(calls).toEqual(CAPABILITY_DEFINITIONS.map(() => 'aiCapability.upsert'));
    expect(upserts(prisma.aiCapability.upsert).map((u) => u.where.slug)).toEqual([
      'search_knowledge_base',
      'get_pattern_detail',
      'estimate_workflow_cost',
    ]);
    // #545: presentation columns stay operator-owned on update.
    expect(Object.keys(upserts(prisma.aiCapability.upsert)[0].update).sort()).toEqual(
      ['executionHandler', 'executionType', 'functionDefinition', 'isSystem'].sort()
    );
  });
});

describe('010-model-auditor', () => {
  it('upserts the three audit capabilities and creates the workflow on a fresh database', async () => {
    const { ctx, prisma, tx } = makeCtx();

    await modelAuditorSeed.run(ctx);

    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: serviceAccountWhere })
    );
    expect(upserts(prisma.aiCapability.upsert).map((u) => u.where.slug)).toEqual([
      'apply_audit_changes',
      'add_provider_models',
      'deactivate_provider_models',
    ]);
    expect(tx.aiWorkflow.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        slug: 'tpl-provider-model-audit',
        isSystem: true,
        isTemplate: false,
        createdBy: 'service-1',
      }),
    });
    expect(mockCreateInitialVersion).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1', userId: 'service-1' })
    );
  });

  it('promotes the current definition to a new version of an existing workflow', async () => {
    const { ctx, tx } = makeCtx({ existingWorkflow: { id: 'wf-9' } });

    await modelAuditorSeed.run(ctx);

    expect(tx.aiWorkflowVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workflowId: 'wf-9', version: 4, createdBy: 'service-1' }),
    });
    expect(tx.aiWorkflow.update).toHaveBeenCalledWith({
      where: { id: 'wf-9' },
      data: expect.objectContaining({ isSystem: true, publishedVersionId: 'v-4' }),
    });
    expect(mockCreateInitialVersion).not.toHaveBeenCalled(); // test-review:accept no_arg_called — an existing workflow is versioned, never re-created
  });

  it('throws when no service account exists', async () => {
    const { ctx } = makeCtx({ owner: false });

    await expect(modelAuditorSeed.run(ctx)).rejects.toThrow(/001-system-owner/);
  });
});

describe('008-mcp-server', () => {
  it('seeds the disabled server config and the three default resources, and no agent', async () => {
    const configUpsert = vi.fn().mockResolvedValue({});
    const resourceUpsert = vi.fn().mockResolvedValue({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    // No aiAgent delegate: an agent write would throw.
    const ctx = {
      prisma: {
        mcpServerConfig: { upsert: configUpsert },
        mcpExposedResource: { upsert: resourceUpsert },
      },
      logger,
    } as unknown as SeedContext;

    await mcpServerSeed.run(ctx);

    expect(configUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'global' },
        update: {},
        create: expect.objectContaining({ isEnabled: false }),
      })
    );
    expect(resourceUpsert.mock.calls.map((c) => c[0].where.uri)).toEqual([
      'sunrise://knowledge/search',
      'sunrise://agents',
      'sunrise://workflows',
    ]);
  });
});
