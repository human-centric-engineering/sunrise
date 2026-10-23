// @vitest-environment happy-dom

/**
 * Tests for `lib/orchestration/backup/importer.ts`
 *
 * Verifies that importOrchestrationConfig() validates the schema,
 * upserts records by slug, skips duplicate webhooks, and reports results.
 *
 * @see lib/orchestration/backup/importer.ts
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The org's provider policy (§120 t-743): approves everything unless a test
// refuses a slug.
const mockUnapprovedProviders = vi.hoisted(() =>
  vi.fn(async (_slugs: readonly string[]): Promise<string[]> => [])
);
// The workflow approval check, mocked at its boundary; the real one is tested
// in semantic-validator.test.ts.
const mockFindUnapprovedModelOverridesIn = vi.hoisted(() =>
  vi.fn(
    async (
      _defs: ReadonlyMap<string, unknown>
    ): Promise<Map<string, { code: string; message: string; stepId: string }[]>> => new Map()
  )
);
vi.mock('@/lib/orchestration/workflows/semantic-validator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/workflows/semantic-validator')>()),
  findUnapprovedModelOverridesIn: mockFindUnapprovedModelOverridesIn,
}));
vi.mock('@/lib/orchestration/llm/org-provider-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/org-provider-policy')>()),
  unapprovedProviders: mockUnapprovedProviders,
}));

// ─── Mocks (declared before imports) ────────────────────────────────────────

// The backup seal's key (§122 t-902). happy-dom hides the server env.
vi.mock('@/lib/env', async (importOriginal) => ({
  env: {
    ...(await importOriginal<typeof import('@/lib/env')>()).env,
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  },
}));

const mockTx = {
  // The erased-person check (t-805): advisory locks, receipts, live users
  $executeRaw: vi.fn(),
  dataErasureReceipt: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  aiAgent: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  aiCapability: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  aiWorkflow: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  aiWorkflowVersion: { findFirst: vi.fn(), create: vi.fn() },
  aiWebhookSubscription: { findFirst: vi.fn(), create: vi.fn() },
  aiOrchestrationSettings: { upsert: vi.fn() },
  knowledgeTag: { upsert: vi.fn(), findMany: vi.fn() },
  aiAgentKnowledgeTag: { deleteMany: vi.fn(), createMany: vi.fn() },
  aiAgentKnowledgeDocument: { deleteMany: vi.fn(), createMany: vi.fn() },
  aiKnowledgeDocument: { findMany: vi.fn() },
};

// The version helpers read the agent back and write `AiAgentVersion` rows;
// their behaviour is proved in agent-versioning's own tests. Here they are
// stubbed so the test can assert WHEN the import calls them.
vi.mock('@/lib/orchestration/agents/agent-versioning', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/orchestration/agents/agent-versioning')>();
  return {
    ...actual,
    ensureBaselineVersion: vi.fn(async () => undefined),
    recordAgentVersion: vi.fn(async () => 2),
  };
});

// The in-org read of which planned slugs this org holds (outside the transaction).
const mockOrgWorkflowFindMany = vi.hoisted(() =>
  vi.fn(async (_args: unknown): Promise<Array<{ slug: string }>> => [])
);

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: { findMany: mockOrgWorkflowFindMany },
    $transaction: vi.fn((fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// The cross-org slug probes (§107 t-728), mocked at their boundary; the real
// ones are proved in slug-availability's own tests.
const mockWorkflowSlugsHeldAnywhere = vi.hoisted(() =>
  vi.fn(async (_slugs: readonly string[]) => new Set<string>())
);
const mockFindFreeWorkflowSlug = vi.hoisted(() =>
  vi.fn(async (slug: string, _alsoTaken?: (candidate: string) => boolean) => `${slug}-1`)
);
vi.mock('@/lib/orchestration/workflows/slug-availability', () => ({
  workflowSlugsHeldAnywhere: mockWorkflowSlugsHeldAnywhere,
  findFreeWorkflowSlug: mockFindFreeWorkflowSlug,
}));

// The tenancy mode, mocked at its boundary: the importer asks `isMultiTenant()`
// for the shared-skip wording and to decide whether the cross-org slug probe
// can find anything. The rest of the module (runAsOrg, getTenantContext) is real.
const mockIsMultiTenant = vi.hoisted(() => vi.fn(() => false));
vi.mock('@/lib/tenancy/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/context')>()),
  isMultiTenant: mockIsMultiTenant,
}));

// The settings caches the importer clears after restoring the settings row.
vi.mock('@/lib/orchestration/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/settings')>()),
  invalidateOrchestrationSettingsCache: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/settings-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/settings-resolver')>()),
  invalidateSettingsCache: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import {
  IMPORTED_FROM_SLUG_KEY,
  IMPORT_TRANSACTION_TIMEOUT_MS,
  importOrchestrationConfig,
  isWorkflowSlugConflict,
} from '@/lib/orchestration/backup/importer';
import { bundleContacts, sealExport } from '@/lib/orchestration/backup/export-seal';
import { COPY_CLOCK_SKEW_MS, SUBJECT_LOCK_WAIT_MS } from '@/lib/privacy/erased-subjects';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getTenantContext } from '@/lib/tenancy/context';
import { invalidateOrchestrationSettingsCache } from '@/lib/orchestration/settings';
import { invalidateSettingsCache } from '@/lib/orchestration/llm/settings-resolver';
import type { BackupScope } from '@/lib/orchestration/backup/scope';
import {
  INITIAL_VERSION_SUMMARY,
  ensureBaselineVersion,
  recordAgentVersion,
} from '@/lib/orchestration/agents/agent-versioning';
import { uniqueViolationError } from '@/tests/helpers/prisma-errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A slug the importer's loop skips as a system workflow. */
const SYSTEM_SLUG = 'tpl-provider-model-audit';
/** A built-in template slug: skipped when carried as a template. */
const BUILTIN_SLUG = 'tpl-customer-support';

/** Install org, shared part included — what the behaviour tests below exercise. */
const SHARED_SCOPE: BackupScope = { orgId: 'install', includeShared: true };
/** A customer org's own part only. */
const OWN_SCOPE: BackupScope = { orgId: 'org_customer', includeShared: false };

const minPayload = {
  schemaVersion: 1,
  exportedAt: '2026-01-01T00:00:00Z',
  data: {
    agents: [],
    capabilities: [],
    workflows: [],
    webhooks: [],
    settings: null,
  },
};

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Support Bot',
    slug: 'support-bot',
    description: 'Handles support queries',
    systemInstructions: 'You are helpful.',
    model: 'gpt-4o',
    provider: 'openai',
    fallbackProviders: [],
    temperature: 0.7,
    maxTokens: 2048,
    monthlyBudgetUsd: null,
    visibility: 'internal',
    isActive: true,
    metadata: null,
    knowledgeCategories: [],
    topicBoundaries: [],
    brandVoiceInstructions: null,
    ...overrides,
  };
}

function makeCapability(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Web Search',
    slug: 'web-search',
    description: 'Searches the web',
    category: 'retrieval',
    functionDefinition: { type: 'object' },
    executionType: 'builtin',
    executionHandler: 'web_search',
    executionConfig: null,
    requiresApproval: false,
    rateLimit: null,
    isActive: true,
    ...overrides,
  };
}

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Onboarding Flow',
    slug: 'onboarding-flow',
    description: 'New user onboarding',
    // Wire payload still uses `workflowDefinition` (the legacy column name).
    // The importer reseeds v1 from this snapshot via createInitialVersion.
    workflowDefinition: {
      steps: [
        {
          id: 'step-1',
          name: 'Step One',
          type: 'chain',
          config: { prompt: 'hi' },
          nextSteps: [],
        },
      ],
      entryStepId: 'step-1',
      errorStrategy: 'fail',
    },
    patternsUsed: [],
    isActive: true,
    isTemplate: false,
    metadata: null,
    ...overrides,
  };
}

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/hook',
    events: ['workflow.completed'],
    description: null,
    isActive: true,
    ...overrides,
  };
}

function makeSettings() {
  return {
    defaultModels: { chat: 'gpt-4o' },
    globalMonthlyBudgetUsd: null,
    searchConfig: null,
    defaultApprovalTimeoutMs: null,
    approvalDefaultAction: null,
    inputGuardMode: null,
    outputGuardMode: null,
    citationGuardMode: null,
    webhookRetentionDays: null,
    costLogRetentionDays: null,
    auditLogRetentionDays: null,
    maxConversationsPerUser: null,
    maxMessagesPerConversation: null,
    escalationConfig: null,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockIsMultiTenant.mockReset();
  mockIsMultiTenant.mockReturnValue(false);
  // Nobody named by a bundle has been erased unless a test says so
  mockTx.$executeRaw.mockReset();
  mockTx.$executeRaw.mockResolvedValue(1);
  mockTx.dataErasureReceipt.findMany.mockReset();
  mockTx.dataErasureReceipt.findMany.mockResolvedValue([]);
  mockTx.user.findMany.mockReset();
  mockTx.user.findMany.mockResolvedValue([]);
});

/** The receipt erasure writes for a verified address, hashed independently of the source. */
function erasedAddressReceipt(address: string) {
  return {
    subjectUserId: 'gone-user',
    subjectEmailHash: createHash('sha256').update(address.trim().toLowerCase()).digest('hex'),
    metadata: { addressVerified: true },
  };
}

describe('importOrchestrationConfig', () => {
  beforeEach(() => {
    // Reset individual tx mock methods — do NOT use vi.resetAllMocks() here because
    // that would also clear the prisma.$transaction implementation set at module level.
    mockTx.aiAgent.findFirst.mockReset();
    mockTx.aiAgent.create.mockReset();
    mockTx.aiAgent.update.mockReset();
    mockTx.aiCapability.findUnique.mockReset();
    mockTx.aiCapability.create.mockReset();
    mockTx.aiCapability.update.mockReset();
    mockTx.aiWorkflow.findUnique.mockReset();
    mockTx.aiWorkflow.create.mockReset();
    mockTx.aiWorkflow.update.mockReset();
    mockTx.aiWorkflowVersion.findFirst.mockReset();
    mockTx.aiWorkflowVersion.create.mockReset();
    mockTx.aiWebhookSubscription.findFirst.mockReset();
    mockTx.aiWebhookSubscription.create.mockReset();
    mockTx.aiOrchestrationSettings.upsert.mockReset();
    mockTx.aiAgentKnowledgeDocument.deleteMany.mockClear();
    mockTx.knowledgeTag.findMany.mockReset();
    mockTx.knowledgeTag.findMany.mockResolvedValue([]);
    mockTx.knowledgeTag.upsert.mockReset();
    mockTx.aiAgentKnowledgeTag.createMany.mockReset();
    mockWorkflowSlugsHeldAnywhere.mockReset();
    mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set());
    mockOrgWorkflowFindMany.mockReset();
    mockOrgWorkflowFindMany.mockResolvedValue([]);
    mockFindFreeWorkflowSlug.mockReset();
    mockFindFreeWorkflowSlug.mockImplementation(async (slug: string) => `${slug}-1`);
    vi.mocked(ensureBaselineVersion).mockClear();
    vi.mocked(recordAgentVersion).mockClear();
  });

  it('throws ZodError when schema is invalid (wrong schemaVersion)', async () => {
    const invalidPayload = { ...minPayload, schemaVersion: 99 };

    await expect(
      importOrchestrationConfig(invalidPayload, 'user-1', SHARED_SCOPE)
    ).rejects.toThrow();
  });

  it('returns zero counts for an empty payload', async () => {
    const result = await importOrchestrationConfig(minPayload, 'user-1', SHARED_SCOPE);

    expect(result.agents).toEqual({ created: 0, updated: 0 });
    expect(result.capabilities).toEqual({ created: 0, updated: 0 });
    expect(result.workflows).toEqual({ created: 0, updated: 0 });
    expect(result.webhooks).toEqual({ created: 0, skipped: 0 });
    expect(result.settingsUpdated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('creates a new agent when no existing record found → agents.created = 1', async () => {
    mockTx.aiAgent.findFirst.mockResolvedValue(null);
    mockTx.aiAgent.create.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, agents: [makeAgent()] } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiAgent.create).toHaveBeenCalledOnce();
    expect(mockTx.aiAgent.update).not.toHaveBeenCalled();
    expect(result.agents.created).toBe(1);
    expect(result.agents.updated).toBe(0);
  });

  it('does not leak the dropped `knowledgeCategories` column into create on a fresh target (#353)', async () => {
    // The CREATE branch spreads the parsed agent into `tx.aiAgent.create`.
    // `knowledgeCategories` is kept on the wire (back-compat) but was dropped from
    // the AiAgent model, so a real Prisma client rejects it as an unknown arg and
    // rolls back the whole import. This mock faithfully reproduces that rejection;
    // the default no-op create mock used elsewhere is exactly why CI missed the bug.
    mockTx.aiAgent.findFirst.mockResolvedValue(null);
    mockTx.aiAgent.create.mockImplementation((args: { data?: Record<string, unknown> }) => {
      if (args?.data && 'knowledgeCategories' in args.data) {
        throw new Error('Unknown argument `knowledgeCategories`.');
      }
      return Promise.resolve({});
    });

    const payload = { ...minPayload, data: { ...minPayload.data, agents: [makeAgent()] } };

    // Before the fix this rejects with the unknown-arg error.
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(result.agents.created).toBe(1);
    expect(mockTx.aiAgent.create).toHaveBeenCalledOnce();
    const createData = mockTx.aiAgent.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(createData).not.toHaveProperty('knowledgeCategories');
  });

  it('imports an agent naming a non-approved provider and warns, rather than skipping it (§120 t-743)', async () => {
    mockUnapprovedProviders.mockImplementationOnce(async (slugs) =>
      slugs.filter((slug) => slug === 'openai')
    );
    mockTx.aiAgent.findFirst.mockResolvedValue(null);
    mockTx.aiAgent.create.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, agents: [makeAgent()] } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(result.agents.created).toBe(1);
    expect(mockTx.aiAgent.create).toHaveBeenCalledOnce();
    expect(result.warnings).toContain(
      'Agent \'support-bot\': imported, but this organisation is not approved to use "openai" — its calls are refused until a platform admin grants it'
    );
  });

  it('updates existing agent when record already exists → agents.updated = 1', async () => {
    mockTx.aiAgent.findFirst.mockResolvedValue({ id: 'existing-id', slug: 'support-bot' });
    mockTx.aiAgent.update.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, agents: [makeAgent()] } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiAgent.update).toHaveBeenCalledOnce();
    expect(mockTx.aiAgent.create).not.toHaveBeenCalled();
    expect(result.agents.updated).toBe(1);
    expect(result.agents.created).toBe(0);
  });

  it("saves an overwritten agent's restored config as a new agent version, after its grants", async () => {
    mockTx.aiAgent.findFirst.mockResolvedValue({ id: 'existing-id', slug: 'support-bot' });
    mockTx.aiAgent.update.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, agents: [makeAgent()] } };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(ensureBaselineVersion).toHaveBeenCalledWith(mockTx, 'existing-id', 'user-1');
    expect(recordAgentVersion).toHaveBeenCalledWith(mockTx, 'existing-id', {
      label: 'Overwritten by backup import',
      createdBy: 'user-1',
    });
    // Baseline before the row changes; the version after the grant rebuild, or
    // it would snapshot the agent's old grants.
    expect(vi.mocked(ensureBaselineVersion).mock.invocationCallOrder[0]).toBeLessThan(
      mockTx.aiAgent.update.mock.invocationCallOrder[0]
    );
    expect(vi.mocked(recordAgentVersion).mock.invocationCallOrder[0]).toBeGreaterThan(
      mockTx.aiAgentKnowledgeDocument.deleteMany.mock.invocationCallOrder[0]
    );
  });

  it("saves a created agent's restored config as its v1", async () => {
    mockTx.aiAgent.findFirst
      .mockResolvedValueOnce(null) // no agent with this slug yet
      .mockResolvedValueOnce({ id: 'new-id' }); // the grant step's lookup
    mockTx.aiAgent.create.mockResolvedValue({ id: 'new-id' });

    const payload = { ...minPayload, data: { ...minPayload.data, agents: [makeAgent()] } };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(recordAgentVersion).toHaveBeenCalledWith(mockTx, 'new-id', {
      label: INITIAL_VERSION_SUMMARY,
      createdBy: 'user-1',
    });
    expect(ensureBaselineVersion).not.toHaveBeenCalled();
  });

  it('creates a new capability → capabilities.created = 1', async () => {
    mockTx.aiCapability.findUnique.mockResolvedValue(null);
    mockTx.aiCapability.create.mockResolvedValue({});

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, capabilities: [makeCapability()] },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiCapability.create).toHaveBeenCalledOnce();
    expect(result.capabilities.created).toBe(1);
  });

  it('creates a new workflow → workflows.created = 1', async () => {
    mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
    mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflow.update.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });

    const payload = { ...minPayload, data: { ...minPayload.data, workflows: [makeWorkflow()] } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWorkflow.create).toHaveBeenCalledOnce();
    expect(mockTx.aiWorkflowVersion.create).toHaveBeenCalledOnce();
    expect(result.workflows.created).toBe(1);
  });

  it('imports a workflow whose steps use non-approved providers, and warns naming the steps (§120 t-743)', async () => {
    mockFindUnapprovedModelOverridesIn.mockResolvedValueOnce(
      new Map([
        [
          'onboarding-flow',
          [{ code: 'PROVIDER_NOT_APPROVED', message: 'not approved', stepId: 'step-1' }],
        ],
      ])
    );
    mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
    mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflow.update.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });

    const payload = { ...minPayload, data: { ...minPayload.data, workflows: [makeWorkflow()] } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(result.workflows.created).toBe(1);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        'Workflow \'onboarding-flow\': imported, but steps "step-1" override to providers'
      ),
    ]);
  });

  it('imports anyway, with one general warning, when the policy cannot be read (§120 t-743)', async () => {
    mockFindUnapprovedModelOverridesIn.mockRejectedValueOnce(new Error('connection reset'));
    mockUnapprovedProviders.mockRejectedValueOnce(new Error('connection reset'));
    mockTx.aiAgent.findFirst.mockResolvedValue(null);
    mockTx.aiAgent.create.mockResolvedValue({});
    mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
    mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflow.update.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, agents: [makeAgent()], workflows: [makeWorkflow()] },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(result.agents.created).toBe(1);
    expect(result.workflows.created).toBe(1);
    expect(result.warnings).toEqual([
      expect.stringContaining('Agents were imported without checking'),
      expect.stringContaining('Workflows were imported without checking'),
    ]);
  });

  it('creates a new webhook when no existing record found → webhooks.created = 1', async () => {
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
    mockTx.aiWebhookSubscription.create.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, webhooks: [makeWebhook()] } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWebhookSubscription.create).toHaveBeenCalledOnce();
    expect(result.webhooks.created).toBe(1);
    expect(result.webhooks.skipped).toBe(0);
  });

  describe('an imported bundle is untrusted data that becomes a destination', () => {
    it('skips a webhook destination on the private network, keeping the rest of the restore', async () => {
      // Per row, not per bundle: refining this in the schema instead would
      // abort the whole restore over one subscription, taking agents,
      // capabilities, workflows and settings with it.
      mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
      mockTx.aiWebhookSubscription.create.mockResolvedValue({});

      const payload = {
        ...minPayload,
        data: {
          ...minPayload.data,
          webhooks: [
            makeWebhook({ url: 'http://169.254.169.254/latest/meta-data/' }),
            makeWebhook({ url: 'https://good.example.com/hook' }),
          ],
        },
      };
      const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

      expect(mockTx.aiWebhookSubscription.create).toHaveBeenCalledOnce();
      expect(result.warnings.some((w) => /private or internal/i.test(w))).toBe(true);
      // CONTROL — the good row still landed, so the skip is targeted rather
      // than the import having failed wholesale.
      expect(result.webhooks.created).toBe(1);
    });

    it('imports an EMAIL subscription inactive, whatever the bundle says', async () => {
      // It used to honour the bundle's own `isActive`, and email delivery needs
      // no secret — so a bundle could stand up a live subscription mailing every
      // matching event, with its full payload, to an address of the bundle
      // author's choosing, with nothing in the result to say so.
      mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
      mockTx.aiWebhookSubscription.create.mockResolvedValue({});

      const payload = {
        ...minPayload,
        data: {
          ...minPayload.data,
          webhooks: [
            makeWebhook({
              channel: 'email',
              url: null,
              emailAddress: 'collector@attacker.example',
              isActive: true,
            }),
          ],
        },
      };
      const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

      expect(mockTx.aiWebhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isActive: false }) })
      );
      expect(result.warnings.some((w) => /imported inactive/i.test(w))).toBe(true);
    });

    it('skips an email subscription whose address is not an address', async () => {
      mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
      mockTx.aiWebhookSubscription.create.mockResolvedValue({});

      const payload = {
        ...minPayload,
        data: {
          ...minPayload.data,
          webhooks: [makeWebhook({ channel: 'email', url: null, emailAddress: 'not-an-address' })],
        },
      };
      const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

      expect(mockTx.aiWebhookSubscription.create).not.toHaveBeenCalled();
      expect(result.warnings.some((w) => /not a valid address/i.test(w))).toBe(true);
    });
  });

  it('skips existing webhook by URL → webhooks.skipped = 1', async () => {
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue({
      id: 'wh-1',
      url: 'https://example.com/hook',
    });

    const payload = { ...minPayload, data: { ...minPayload.data, webhooks: [makeWebhook()] } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWebhookSubscription.create).not.toHaveBeenCalled();
    expect(result.webhooks.skipped).toBe(1);
    expect(result.webhooks.created).toBe(0);
  });

  it('sets settingsUpdated: true when settings are present in the payload', async () => {
    mockTx.aiOrchestrationSettings.upsert.mockResolvedValue({});

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, settings: makeSettings() },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiOrchestrationSettings.upsert).toHaveBeenCalledOnce();
    // test-review:accept tobe_true — boolean field `settingsUpdated` on ImportResult; structural assertion on import outcome
    expect(result.settingsUpdated).toBe(true);
    // The restored settings (the global budget cap among them) take effect on
    // this process's next read, as a settings PATCH does.
    expect(invalidateOrchestrationSettingsCache).toHaveBeenCalledOnce();
    expect(invalidateSettingsCache).toHaveBeenCalledOnce();
  });

  it('restores the failed-webhook retention window (#838)', async () => {
    mockTx.aiOrchestrationSettings.upsert.mockResolvedValue({});

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, settings: { ...makeSettings(), webhookDlqRetentionDays: 45 } },
    };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    const call = mockTx.aiOrchestrationSettings.upsert.mock.calls[0][0];
    expect(call.create.webhookDlqRetentionDays).toBe(45);
    expect(call.update.webhookDlqRetentionDays).toBe(45);
  });

  it('leaves the current failed-webhook window alone when the backup predates it', async () => {
    mockTx.aiOrchestrationSettings.upsert.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, settings: makeSettings() } };
    expect(payload.data.settings).not.toHaveProperty('webhookDlqRetentionDays');
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    // Undefined is Prisma's "do not write"; null would clear a window the
    // operator set after the backup was taken.
    const call = mockTx.aiOrchestrationSettings.upsert.mock.calls[0][0];
    expect(call.update.webhookDlqRetentionDays).toBeUndefined();
    expect(call.update.webhookRetentionDays).toBeNull();
  });

  it.each([0, -1, 1.5, 366])('refuses a backup whose failed-webhook window is %s', async (days) => {
    const payload = {
      ...minPayload,
      data: { ...minPayload.data, settings: { ...makeSettings(), webhookDlqRetentionDays: days } },
    };
    await expect(importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE)).rejects.toThrow();
    expect(mockTx.aiOrchestrationSettings.upsert).not.toHaveBeenCalled();
  });

  it('sets settingsUpdated: false when settings is null', async () => {
    const payload = { ...minPayload, data: { ...minPayload.data, settings: null } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiOrchestrationSettings.upsert).not.toHaveBeenCalled();
    expect(result.settingsUpdated).toBe(false);
    expect(invalidateOrchestrationSettingsCache).not.toHaveBeenCalled(); // test-review:accept no_arg_called — nothing restored, nothing to clear
  });

  it('adds a warning to warnings array when a webhook is imported without a secret', async () => {
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
    mockTx.aiWebhookSubscription.create.mockResolvedValue({});

    // Webhook payload without secret (as exported — secret is never in export)
    const webhook = makeWebhook();
    const payload = { ...minPayload, data: { ...minPayload.data, webhooks: [webhook] } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    // The importer adds a warning for every new webhook (secrets are never exported)
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('https://example.com/hook');
    expect(result.warnings[0]).toContain('secret');
  });

  it('forces imported webhook to isActive: false even when payload was active', async () => {
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
    mockTx.aiWebhookSubscription.create.mockResolvedValue({});

    // Payload says isActive: true — importer must still create as inactive to
    // prevent empty-secret HMAC dispatches
    const webhook = makeWebhook({ isActive: true });
    const payload = { ...minPayload, data: { ...minPayload.data, webhooks: [webhook] } };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWebhookSubscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        url: 'https://example.com/hook',
        secret: '',
        isActive: false,
      }),
    });
  });

  it('appends a new version when the workflow already exists (does not create v1)', async () => {
    // Existing workflow in DB → importer should append a vN+1 row pointing at
    // the imported snapshot, not create a fresh workflow row.
    mockTx.aiWorkflow.findUnique.mockResolvedValue({ id: 'wf-existing' });
    mockTx.aiWorkflowVersion.findFirst.mockResolvedValue({ version: 3 });
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-new', version: 4 });
    mockTx.aiWorkflow.update.mockResolvedValue({ id: 'wf-existing' });

    const payload = { ...minPayload, data: { ...minPayload.data, workflows: [makeWorkflow()] } };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWorkflow.create).not.toHaveBeenCalled();
    expect(mockTx.aiWorkflowVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowId: 'wf-existing',
        version: 4,
        changeSummary: 'Imported from backup',
        createdBy: 'user-1',
      }),
    });
    expect(mockTx.aiWorkflow.update).toHaveBeenCalledWith({
      where: { id: 'wf-existing' },
      data: expect.objectContaining({ publishedVersionId: 'wfv-new' }),
    });
    expect(result.workflows.updated).toBe(1);
    expect(result.workflows.created).toBe(0);
  });

  it('starts versions at 1 when the existing workflow has no version rows yet', async () => {
    // Defensive case: an existing AiWorkflow with zero version rows. Should
    // not crash; the new version becomes v1 (lastVersion?.version ?? 0) + 1.
    mockTx.aiWorkflow.findUnique.mockResolvedValue({ id: 'wf-empty' });
    mockTx.aiWorkflowVersion.findFirst.mockResolvedValue(null);
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });
    mockTx.aiWorkflow.update.mockResolvedValue({ id: 'wf-empty' });

    const payload = { ...minPayload, data: { ...minPayload.data, workflows: [makeWorkflow()] } };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWorkflowVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 1 }),
    });
  });

  it('skips a workflow with a malformed snapshot and emits a warning', async () => {
    // A backup payload whose `workflowDefinition` fails workflowDefinitionSchema
    // must not be imported — the warning surfaces in result.warnings and no
    // version is created.
    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        workflows: [
          makeWorkflow({
            // Missing entryStepId, no steps — fails Zod parse
            workflowDefinition: { steps: [], errorStrategy: 'fail' },
          }),
        ],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWorkflow.create).not.toHaveBeenCalled();
    expect(mockTx.aiWorkflowVersion.create).not.toHaveBeenCalled();
    expect(result.workflows.created).toBe(0);
    expect(result.workflows.updated).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/onboarding-flow.*definition failed validation/i),
      ])
    );
  });

  it('skips a built-in slug carried as a template: the seed-era row (§116 t-727)', async () => {
    // The retired seed row still holds the slug on an upgraded install; a
    // backup taken before the upgrade must not bring it back as a template.
    mockTx.aiWorkflow.findUnique.mockResolvedValue({ id: 'wf-retired' });
    mockTx.aiWorkflowVersion.findFirst.mockResolvedValue({ version: 1 });
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-2', version: 2 });
    mockTx.aiWorkflow.update.mockResolvedValue({ id: 'wf-retired' });

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        workflows: [
          makeWorkflow({ slug: 'tpl-customer-support', isTemplate: true }),
          makeWorkflow(),
        ],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    // Only the ordinary workflow is looked up and written; the built-in never
    // reaches the database.
    expect(mockTx.aiWorkflow.findUnique).toHaveBeenCalledTimes(1);
    expect(mockTx.aiWorkflow.update).toHaveBeenCalledTimes(1);
    expect(mockTx.aiWorkflowVersion.create).toHaveBeenCalledTimes(1);
    expect(mockTx.aiWorkflow.create).not.toHaveBeenCalled();
    expect(mockTx.aiWorkflow.findUnique).toHaveBeenCalledWith({
      where: { slug: 'onboarding-flow' },
    });
    expect(result.workflows).toEqual({ created: 0, updated: 1 });
    expect(result.warnings).toEqual([
      "Workflow 'tpl-customer-support' skipped — built-in templates are served from code, not restored from a backup",
    ]);
  });

  it('imports an ordinary workflow holding a built-in slug: a row the install switched back on', async () => {
    // A retired row an install turned back on (or one an admin converted) is
    // live config. Skipping it would silently drop a running workflow.
    mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
    mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-new' });
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        workflows: [makeWorkflow({ slug: 'tpl-scheduled-source-monitor', isTemplate: false })],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWorkflow.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ slug: 'tpl-scheduled-source-monitor', isTemplate: false }),
    });
    expect(result.workflows).toEqual({ created: 1, updated: 0 });
    expect(result.warnings).toEqual([]);
  });

  it('skips the system workflow by slug on a target with no row, even with a now-invalid definition (t-729)', async () => {
    // A bundle exported before t-729 carries the provider-model audit. On a
    // target where that row is absent — or another org's, at `multi` — the
    // row flag cannot see it, so without the slug check the import would
    // create an ordinary copy (single) or P2002 and roll back (multi). An old
    // definition the schema now rejects must report THIS reason, not "failed
    // validation", which reads as a corrupt backup.
    mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
    mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-new' });
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        workflows: [
          makeWorkflow({
            slug: 'tpl-provider-model-audit',
            isActive: false,
            workflowDefinition: { steps: [], entryStepId: 'missing', errorStrategy: 'fail' },
          }),
          makeWorkflow(),
        ],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    // The system slug never reaches the database; the ordinary one restores.
    expect(mockTx.aiWorkflow.findUnique).toHaveBeenCalledTimes(1);
    expect(mockTx.aiWorkflow.findUnique).toHaveBeenCalledWith({
      where: { slug: 'onboarding-flow' },
    });
    expect(mockTx.aiWorkflow.create).toHaveBeenCalledTimes(1);
    expect(mockTx.aiWorkflow.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ slug: 'onboarding-flow' }),
    });
    expect(result.workflows).toEqual({ created: 1, updated: 0 });
    expect(result.warnings).toEqual([
      "System workflow 'tpl-provider-model-audit' skipped — system workflows cannot be overwritten by backup import",
    ]);
  });

  it('skips an existing system workflow the slug list does not know, by its row flag, before parsing its definition (t-729)', async () => {
    // A fork's own seeded system workflow: not in SYSTEM_WORKFLOW_SLUGS, but
    // its row says isSystem. Versioning over it would republish the bundle's
    // definition and could deactivate it, which PATCH refuses. Its old
    // definition fails today's schema, and the reason must still be the
    // system-workflow one, not "definition failed validation".
    mockTx.aiWorkflow.findUnique.mockResolvedValue({
      id: 'wf-sys',
      slug: 'fork-system-flow',
      isSystem: true,
    });

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        workflows: [
          makeWorkflow({
            slug: 'fork-system-flow',
            isActive: false,
            workflowDefinition: { steps: [], entryStepId: 'missing', errorStrategy: 'fail' },
          }),
        ],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWorkflow.update).not.toHaveBeenCalled();
    expect(mockTx.aiWorkflowVersion.findFirst).not.toHaveBeenCalled();
    expect(mockTx.aiWorkflowVersion.create).not.toHaveBeenCalled();
    expect(mockTx.aiWorkflow.create).not.toHaveBeenCalled();
    expect(result.workflows).toEqual({ created: 0, updated: 0 });
    expect(result.warnings).toEqual([
      "System workflow 'fork-system-flow' skipped — system workflows cannot be overwritten by backup import",
    ]);
  });
});

// ─── Knowledge tag import ────────────────────────────────────────────────────

describe('importOrchestrationConfig — people whose data was erased (t-805)', () => {
  const ERASED_ADDRESS = 'gone@example.com';
  const ERASED_ID = 'cmerasedapprover00000000';

  function notifyAndApprove(to: string[], approverUserIds: string[]) {
    return makeWorkflow({
      workflowDefinition: {
        steps: [
          {
            id: 'notify',
            name: 'Notify',
            type: 'send_notification',
            config: { channel: 'email', to, subject: 'Hi', bodyTemplate: 'x' },
            nextSteps: [{ targetStepId: 'approve' }],
          },
          {
            id: 'approve',
            name: 'Approve',
            type: 'human_approval',
            config: { prompt: 'OK?', approverUserIds },
            nextSteps: [],
          },
        ],
        entryStepId: 'notify',
        errorStrategy: 'fail',
      },
    });
  }

  beforeEach(() => {
    mockTx.aiWorkflow.findUnique.mockReset();
    mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
    mockTx.aiWorkflow.create.mockReset();
    mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflow.update.mockReset();
    mockTx.aiWorkflow.update.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflowVersion.create.mockReset();
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });
    mockTx.aiWebhookSubscription.findFirst.mockReset();
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
    mockTx.aiWebhookSubscription.create.mockReset();
    mockTx.aiWebhookSubscription.create.mockResolvedValue({});
    mockTx.aiOrchestrationSettings.upsert.mockReset();
    mockTx.aiOrchestrationSettings.upsert.mockResolvedValue({});
    mockTx.knowledgeTag.findMany.mockResolvedValue([]);
    mockWorkflowSlugsHeldAnywhere.mockReset();
    mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set());
    mockOrgWorkflowFindMany.mockReset();
    mockOrgWorkflowFindMany.mockResolvedValue([]);
    mockTx.dataErasureReceipt.findMany.mockResolvedValue([
      erasedAddressReceipt(ERASED_ADDRESS),
      { subjectUserId: ERASED_ID, subjectEmailHash: null, metadata: null },
    ]);
  });

  it('holds the locks no longer than erasure waits for them ahead of its transaction (t-840)', async () => {
    const payload = {
      ...minPayload,
      data: { ...minPayload.data, workflows: [notifyAndApprove([ERASED_ADDRESS], [])] },
    };

    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    // The import takes the locks at the start of this transaction and holds
    // them to its end, so an erasure waiting for SUBJECT_LOCK_WAIT_MS outlasts
    // any import rather than timing out behind a long one.
    expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      timeout: IMPORT_TRANSACTION_TIMEOUT_MS,
    });
    expect(SUBJECT_LOCK_WAIT_MS).toBeGreaterThan(IMPORT_TRANSACTION_TIMEOUT_MS);
  });

  it('imports a workflow with the erased address and approver stripped, and warns', async () => {
    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        workflows: [
          notifyAndApprove(['Gone@Example.com', 'keep@example.com'], [ERASED_ID, 'live-approver']),
        ],
      },
    };

    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    const created = mockTx.aiWorkflowVersion.create.mock.calls[0]?.[0] as {
      data: { snapshot: { steps: Array<{ config: Record<string, unknown> }> } };
    };
    const steps = created.data.snapshot.steps;
    expect(steps[0].config.to).toEqual(['keep@example.com']);
    expect(steps[1].config.approverUserIds).toEqual(['live-approver']);
    expect(result.workflows.created).toBe(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/onboarding-flow.*people whose data was erased were removed/i),
      ])
    );
    // Asked up front, under the locks, about the approvers and the addresses
    expect(mockTx.$executeRaw).toHaveBeenCalled();
    const asked = mockTx.dataErasureReceipt.findMany.mock.calls.map((c) => c[0]);
    expect(asked).toContainEqual(
      expect.objectContaining({
        where: {
          OR: [{ subjectUserId: { in: expect.arrayContaining([ERASED_ID, 'live-approver']) } }],
        },
      })
    );
    expect(asked).toContainEqual(
      expect.objectContaining({
        where: { OR: [{ subjectEmailHash: { in: expect.arrayContaining([expect.any(String)]) } }] },
      })
    );
  });

  it('strips the erased person from a new version of an existing workflow too', async () => {
    mockTx.aiWorkflow.findUnique.mockResolvedValue({ id: 'wf-existing' });
    mockTx.aiWorkflowVersion.findFirst.mockResolvedValue({ version: 1 });
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-2', version: 2 });
    const payload = {
      ...minPayload,
      data: { ...minPayload.data, workflows: [notifyAndApprove([ERASED_ADDRESS], [ERASED_ID])] },
    };

    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    const created = mockTx.aiWorkflowVersion.create.mock.calls[0]?.[0] as {
      data: { snapshot: { steps: Array<{ config: Record<string, unknown> }> } };
    };
    expect(created.data.snapshot.steps[0].config.to).toEqual([]);
    expect(created.data.snapshot.steps[1].config.approverUserIds).toEqual([]);
    expect(result.warnings.some((w) => /were removed/.test(w))).toBe(true);
  });

  it('leaves a workflow that names nobody erased untouched, with no warning', async () => {
    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        workflows: [notifyAndApprove(['keep@example.com'], ['live-approver'])],
      },
    };
    mockTx.dataErasureReceipt.findMany.mockResolvedValue([]);

    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    const created = mockTx.aiWorkflowVersion.create.mock.calls[0]?.[0] as {
      data: { snapshot: { steps: Array<{ config: Record<string, unknown> }> } };
    };
    expect(created.data.snapshot.steps[0].config.to).toEqual(['keep@example.com']);
    expect(created.data.snapshot.steps[1].config.approverUserIds).toEqual(['live-approver']);
    expect(result.warnings.some((w) => /were removed/.test(w))).toBe(false);
  });

  it('skips an email subscription whose address was erased, without echoing the address', async () => {
    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        webhooks: [makeWebhook({ channel: 'email', url: null, emailAddress: 'GONE@Example.com' })],
      },
    };

    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWebhookSubscription.create).not.toHaveBeenCalled();
    const warning = result.warnings.find((w) => /person whose data was erased/.test(w));
    expect(warning).toBeDefined();
    expect(warning).not.toContain('gone@example.com');
    expect(result.webhooks.created).toBe(0);
  });

  it('imports an email subscription for a different address as before', async () => {
    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        webhooks: [makeWebhook({ channel: 'email', url: null, emailAddress: 'other@example.com' })],
      },
    };

    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWebhookSubscription.create).toHaveBeenCalledOnce();
    expect(result.webhooks.created).toBe(1);
  });

  it('filters the erased address out of the escalation list and warns', async () => {
    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        settings: {
          ...makeSettings(),
          escalationConfig: {
            emailAddresses: ['gone@example.com', 'keep@example.com'],
            notifyOnPriority: 'high',
          },
        },
      },
    };

    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    const upsert = mockTx.aiOrchestrationSettings.upsert.mock.calls[0]?.[0] as {
      create: { escalationConfig: unknown };
      update: { escalationConfig: unknown };
    };
    const expected = { emailAddresses: ['keep@example.com'], notifyOnPriority: 'high' };
    expect(upsert.create.escalationConfig).toEqual(expected);
    expect(upsert.update.escalationConfig).toEqual(expected);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Escalation list.*were removed/)])
    );
  });

  it('does not look at the escalation list when the shared part is not imported', async () => {
    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        settings: {
          ...makeSettings(),
          escalationConfig: { emailAddresses: ['gone@example.com'], notifyOnPriority: 'all' },
        },
      },
    };

    await importOrchestrationConfig(payload, 'user-1', OWN_SCOPE);

    expect(mockTx.aiOrchestrationSettings.upsert).not.toHaveBeenCalled();
    // Nothing else in the bundle names anyone, so no receipt was asked for
    expect(mockTx.dataErasureReceipt.findMany).not.toHaveBeenCalled();
  });
});

describe('importOrchestrationConfig — knowledgeTags', () => {
  beforeEach(() => {
    mockTx.aiAgent.findFirst.mockReset();
    mockTx.aiAgent.create.mockReset();
    mockTx.aiAgent.update.mockReset();
    mockTx.knowledgeTag.upsert.mockReset();
    mockTx.aiAgentKnowledgeTag.deleteMany.mockReset();
    mockTx.aiAgentKnowledgeTag.createMany.mockReset();
    mockTx.aiAgentKnowledgeDocument.deleteMany.mockReset();
    mockTx.aiAgentKnowledgeDocument.createMany.mockReset();
    mockTx.aiKnowledgeDocument.findMany.mockReset();
  });

  it('creates a new knowledge tag and increments knowledgeTags.created', async () => {
    const now = new Date();
    // Same createdAt and updatedAt → newly created row
    mockTx.knowledgeTag.upsert.mockResolvedValue({
      slug: 'support',
      id: 'tag-1',
      createdAt: now,
      updatedAt: now,
    });

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        knowledgeTags: [{ slug: 'support', name: 'Support', description: null }],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.knowledgeTag.upsert).toHaveBeenCalledWith({
      where: { slug: 'support' },
      create: { slug: 'support', name: 'Support', description: null },
      update: { name: 'Support', description: null },
    });
    expect(result.knowledgeTags.created).toBe(1);
    expect(result.knowledgeTags.updated).toBe(0);
  });

  it('counts as updated when createdAt and updatedAt differ', async () => {
    const createdAt = new Date('2024-01-01');
    const updatedAt = new Date('2024-06-01');
    mockTx.knowledgeTag.upsert.mockResolvedValue({
      slug: 'billing',
      id: 'tag-2',
      createdAt,
      updatedAt,
    });

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        knowledgeTags: [{ slug: 'billing', name: 'Billing', description: 'billing topics' }],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(result.knowledgeTags.updated).toBe(1);
    expect(result.knowledgeTags.created).toBe(0);
  });

  it('imports multiple tags and sums created/updated counts correctly', async () => {
    const now = new Date();
    const past = new Date('2024-01-01');
    mockTx.knowledgeTag.upsert
      .mockResolvedValueOnce({ slug: 'new-tag', id: 'tag-n', createdAt: now, updatedAt: now })
      .mockResolvedValueOnce({
        slug: 'old-tag',
        id: 'tag-o',
        createdAt: past,
        updatedAt: new Date(),
      });

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        knowledgeTags: [
          { slug: 'new-tag', name: 'New Tag', description: null },
          { slug: 'old-tag', name: 'Old Tag', description: 'pre-existing' },
        ],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(result.knowledgeTags.created).toBe(1);
    expect(result.knowledgeTags.updated).toBe(1);
  });
});

// ─── System agent skip ────────────────────────────────────────────────────────

describe('importOrchestrationConfig — system agent protection', () => {
  beforeEach(() => {
    mockTx.aiAgent.findFirst.mockReset();
    mockTx.aiAgent.create.mockReset();
    mockTx.aiAgent.update.mockReset();
    mockTx.aiAgentKnowledgeTag.deleteMany.mockReset();
    mockTx.aiAgentKnowledgeTag.createMany.mockReset();
    mockTx.aiAgentKnowledgeDocument.deleteMany.mockReset();
    mockTx.aiAgentKnowledgeDocument.createMany.mockReset();
    mockTx.aiKnowledgeDocument.findMany.mockReset();
  });

  it('skips a system agent and adds a warning instead of updating it', async () => {
    // Existing record has isSystem: true — the import must not overwrite it.
    mockTx.aiAgent.findFirst.mockResolvedValue({
      id: 'sys-1',
      slug: 'system-bot',
      isSystem: true,
    });

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, agents: [makeAgent({ slug: 'system-bot' })] },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiAgent.update).not.toHaveBeenCalled();
    expect(mockTx.aiAgent.create).not.toHaveBeenCalled();
    expect(result.agents.updated).toBe(0);
    expect(result.agents.created).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('system-bot')])
    );
    expect(result.warnings[0]).toMatch(/system agents cannot be overwritten/i);
  });

  it('skips a platform slug the org has no agent under: the reconcile creates it (§116 t-725)', async () => {
    mockTx.aiAgent.findFirst.mockResolvedValue(null);

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, agents: [makeAgent({ slug: 'eval-judge-relevance' })] },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiAgent.create).not.toHaveBeenCalled();
    expect(mockTx.aiAgentKnowledgeTag.createMany).not.toHaveBeenCalled();
    expect(result.agents.created).toBe(0);
    expect(result.warnings).toEqual([
      'Agent \'eval-judge-relevance\' skipped — The slug "eval-judge-relevance" is reserved for a platform agent',
    ]);
  });

  it("does not overwrite an org's own agent holding a platform slug", async () => {
    mockTx.aiAgent.findFirst.mockResolvedValue({
      id: 'own-1',
      slug: 'quiz-master',
      isSystem: false,
    });

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, agents: [makeAgent({ slug: 'quiz-master' })] },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiAgent.update).not.toHaveBeenCalled();
    expect(result.agents.updated).toBe(0);
    expect(result.warnings[0]).toContain('reserved for a platform agent');
  });
});

// ─── Grant resolution ─────────────────────────────────────────────────────────

describe('importOrchestrationConfig — knowledge grants', () => {
  beforeEach(() => {
    mockTx.aiAgent.findFirst.mockReset();
    mockTx.aiAgent.create.mockReset();
    mockTx.aiAgent.update.mockReset();
    mockTx.knowledgeTag.upsert.mockReset();
    mockTx.aiAgentKnowledgeTag.deleteMany.mockReset();
    mockTx.aiAgentKnowledgeTag.createMany.mockReset();
    mockTx.aiAgentKnowledgeDocument.deleteMany.mockReset();
    mockTx.aiAgentKnowledgeDocument.createMany.mockReset();
    mockTx.aiKnowledgeDocument.findMany.mockReset();
  });

  it('resolves tag grants from the tagIdBySlug map and calls createMany', async () => {
    const now = new Date();
    // Tag upsert builds the tagIdBySlug map
    mockTx.knowledgeTag.upsert.mockResolvedValue({
      slug: 'support',
      id: 'tag-1',
      createdAt: now,
      updatedAt: now,
    });
    // Agent does not exist yet → create path
    mockTx.aiAgent.findFirst
      .mockResolvedValueOnce(null) // first call: slug lookup for upsert
      .mockResolvedValueOnce({ id: 'agent-1' }); // second call: select id for grants
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-1' });
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([]);

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        knowledgeTags: [{ slug: 'support', name: 'Support', description: null }],
        agents: [makeAgent({ grantedTagSlugs: ['support'], grantedDocumentHashes: [] })],
      },
    };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiAgentKnowledgeTag.deleteMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-1' },
    });
    expect(mockTx.aiAgentKnowledgeTag.createMany).toHaveBeenCalledWith({
      data: [{ agentId: 'agent-1', tagId: 'tag-1' }],
      skipDuplicates: true,
    });
  });

  it('emits a warning when a grantedTagSlug does not map to a known tag', async () => {
    // No knowledgeTags in payload → tagIdBySlug is empty
    mockTx.aiAgent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-2' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-2' });
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([]);

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        agents: [makeAgent({ grantedTagSlugs: ['missing-tag'], grantedDocumentHashes: [] })],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    // No createMany for tags because resolution failed
    expect(mockTx.aiAgentKnowledgeTag.createMany).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/missing knowledge-tag slug 'missing-tag'/)])
    );
  });

  it('resolves document grants by fileHash and calls createMany', async () => {
    mockTx.aiAgent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-3' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-3' });
    // The DB has a doc with matching fileHash
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([
      { id: 'doc-1', fileHash: 'abc123hash' },
    ]);

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        agents: [makeAgent({ grantedTagSlugs: [], grantedDocumentHashes: ['abc123hash'] })],
      },
    };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiAgentKnowledgeDocument.deleteMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-3' },
    });
    expect(mockTx.aiAgentKnowledgeDocument.createMany).toHaveBeenCalledWith({
      data: [{ agentId: 'agent-3', documentId: 'doc-1' }],
      skipDuplicates: true,
    });
  });

  it('resolves document grants by slug (v3) and calls createMany', async () => {
    mockTx.aiAgent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-3a' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-3a' });
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([
      { id: 'doc-9', slug: 'handbook-abc12345' },
    ]);

    const payload = {
      ...minPayload,
      schemaVersion: 3 as const,
      data: {
        ...minPayload.data,
        agents: [makeAgent({ grantedTagSlugs: [], grantedDocumentSlugs: ['handbook-abc12345'] })],
      },
    };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    // Lookup is by slug, not fileHash.
    expect(mockTx.aiKnowledgeDocument.findMany).toHaveBeenCalledWith({
      where: { slug: { in: ['handbook-abc12345'] } },
      select: { id: true, slug: true },
    });
    expect(mockTx.aiAgentKnowledgeDocument.createMany).toHaveBeenCalledWith({
      data: [{ agentId: 'agent-3a', documentId: 'doc-9' }],
      skipDuplicates: true,
    });
  });

  it('prefers slug over fileHash when a v3 bundle carries both', async () => {
    mockTx.aiAgent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-3b' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-3b' });
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([
      { id: 'doc-by-slug', slug: 'handbook-abc12345' },
    ]);

    const payload = {
      ...minPayload,
      schemaVersion: 3 as const,
      data: {
        ...minPayload.data,
        agents: [
          makeAgent({
            grantedTagSlugs: [],
            grantedDocumentSlugs: ['handbook-abc12345'],
            grantedDocumentHashes: ['ignoredhash'],
          }),
        ],
      },
    };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    // Only the slug lookup runs — the hash fallback is skipped when slugs exist.
    expect(mockTx.aiKnowledgeDocument.findMany).toHaveBeenCalledTimes(1);
    expect(mockTx.aiKnowledgeDocument.findMany).toHaveBeenCalledWith({
      where: { slug: { in: ['handbook-abc12345'] } },
      select: { id: true, slug: true },
    });
    expect(mockTx.aiAgentKnowledgeDocument.createMany).toHaveBeenCalledWith({
      data: [{ agentId: 'agent-3b', documentId: 'doc-by-slug' }],
      skipDuplicates: true,
    });
  });

  it('emits a warning for a missing document slug and skips that grant (warn-skip, not fail)', async () => {
    mockTx.aiAgent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-3c' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-3c' });
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([]); // slug not present

    const payload = {
      ...minPayload,
      schemaVersion: 3 as const,
      data: {
        ...minPayload.data,
        agents: [makeAgent({ grantedTagSlugs: [], grantedDocumentSlugs: ['gone-deadbeef'] })],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiAgentKnowledgeDocument.createMany).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/missing knowledge document slug.*gone-deadbeef/i),
      ])
    );
  });

  it('emits a warning for missing document hashes and skips the missing doc grant', async () => {
    mockTx.aiAgent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-4' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-4' });
    // DB returns empty — hash not found
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([]);

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        agents: [makeAgent({ grantedTagSlugs: [], grantedDocumentHashes: ['deadbeef1234'] })],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiAgentKnowledgeDocument.createMany).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/missing knowledge document.*deadbeef1234/i)])
    );
  });

  it('does not call createMany for tags when there are no resolved tag ids', async () => {
    mockTx.aiAgent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-5' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-5' });
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([]);

    // No granted slugs at all — agent has no grants
    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        agents: [makeAgent({ grantedTagSlugs: [], grantedDocumentHashes: [] })],
      },
    };
    await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    // deleteMany is still called to clear stale grants, but createMany is not
    expect(mockTx.aiAgentKnowledgeTag.deleteMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-5' },
    });
    expect(mockTx.aiAgentKnowledgeTag.createMany).not.toHaveBeenCalled();
    expect(mockTx.aiAgentKnowledgeDocument.deleteMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-5' },
    });
    expect(mockTx.aiAgentKnowledgeDocument.createMany).not.toHaveBeenCalled();
  });
});

// ─── v1 compatibility — slugify from knowledgeCategories ─────────────────────

describe('importOrchestrationConfig — v1 schemaVersion compatibility', () => {
  beforeEach(() => {
    mockTx.aiAgent.findFirst.mockReset();
    mockTx.aiAgent.create.mockReset();
    mockTx.aiAgent.update.mockReset();
    mockTx.knowledgeTag.upsert.mockReset();
    mockTx.aiAgentKnowledgeTag.deleteMany.mockReset();
    mockTx.aiAgentKnowledgeTag.createMany.mockReset();
    mockTx.aiAgentKnowledgeDocument.deleteMany.mockReset();
    mockTx.aiAgentKnowledgeDocument.createMany.mockReset();
    mockTx.aiKnowledgeDocument.findMany.mockReset();
  });

  it('infers tag slugs from knowledgeCategories when schemaVersion is 1', async () => {
    const now = new Date();
    // The upsert call that creates/updates the inferred tag
    mockTx.knowledgeTag.upsert.mockResolvedValue({
      slug: 'billing-support',
      id: 'tag-inf',
      createdAt: now,
      updatedAt: now,
    });
    mockTx.aiAgent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-v1' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-v1' });
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([]);

    const v1Payload = {
      schemaVersion: 1 as const,
      exportedAt: '2025-01-01T00:00:00Z',
      data: {
        agents: [
          makeAgent({
            slug: 'v1-agent',
            knowledgeCategories: ['Billing Support'],
            grantedTagSlugs: [],
            grantedDocumentHashes: [],
          }),
        ],
        capabilities: [],
        workflows: [],
        webhooks: [],
        settings: null,
      },
    };
    const result = await importOrchestrationConfig(v1Payload, 'user-1', SHARED_SCOPE);

    // The importer slugifies 'Billing Support' → 'billing-support' and upserts it
    expect(mockTx.knowledgeTag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'billing-support' } })
    );
    // Tag created counted
    expect(result.knowledgeTags.created).toBe(1);
  });

  it('skips blank knowledgeCategories entries when inferring v1 tags', async () => {
    mockTx.aiAgent.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'agent-blank' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-blank' });
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([]);

    const v1Payload = {
      schemaVersion: 1 as const,
      exportedAt: '2025-01-01T00:00:00Z',
      data: {
        agents: [
          makeAgent({
            slug: 'v1-blank',
            // All blank — should produce no upserts
            knowledgeCategories: ['   ', ''],
            grantedTagSlugs: [],
            grantedDocumentHashes: [],
          }),
        ],
        capabilities: [],
        workflows: [],
        webhooks: [],
        settings: null,
      },
    };
    await importOrchestrationConfig(v1Payload, 'user-1', SHARED_SCOPE);

    // No tag upsert should have been called (blank categories produce no slug)
    expect(mockTx.knowledgeTag.upsert).not.toHaveBeenCalled();
  });
});

// ─── Capability update path ───────────────────────────────────────────────────

describe('importOrchestrationConfig — capability update', () => {
  beforeEach(() => {
    mockTx.aiCapability.findUnique.mockReset();
    mockTx.aiCapability.create.mockReset();
    mockTx.aiCapability.update.mockReset();
  });

  it('updates an existing capability → capabilities.updated = 1', async () => {
    mockTx.aiCapability.findUnique.mockResolvedValue({ id: 'cap-1', slug: 'web-search' });
    mockTx.aiCapability.update.mockResolvedValue({});

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, capabilities: [makeCapability()] },
    };
    const result = await importOrchestrationConfig(payload, 'user-1', SHARED_SCOPE);

    expect(mockTx.aiCapability.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'web-search' } })
    );
    expect(mockTx.aiCapability.create).not.toHaveBeenCalled();
    expect(result.capabilities.updated).toBe(1);
    expect(result.capabilities.created).toBe(0);
  });

  // ── Seed-owned fields on a system capability (#598) ────────────────────────
  //
  // The seeds re-apply `functionDefinition` / `executionType` /
  // `executionHandler` on every deploy whose seed-file hash changes, so
  // importing them onto a system row writes a change the next re-seed reverts
  // with no audit entry. The importer skips just those fields rather than
  // skipping the row (which is what the agent path does): an import is a
  // whole-config restore, and failing it because the bundle carries a built-in's
  // shipped definition would make routine restores unusable.
  describe('system capabilities', () => {
    /** Key order as Postgres canonicalises jsonb: shortest key first. */
    const STORED_DEFINITION = {
      name: 'search_kb',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      description: 'Search the knowledge base.',
    };

    /** Same value, as a bundle round-tripped through Zod serialises it. */
    const BUNDLED_DEFINITION = {
      name: 'search_kb',
      description: 'Search the knowledge base.',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    };

    function existingSystemRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'cap-sys',
        slug: 'search_kb',
        isSystem: true,
        functionDefinition: STORED_DEFINITION,
        executionType: 'internal',
        executionHandler: 'SearchKnowledgeCapability',
        ...overrides,
      };
    }

    function bundleWith(cap: Record<string, unknown>) {
      return { ...minPayload, data: { ...minPayload.data, capabilities: [cap] } };
    }

    it('imports operator-owned fields but not seed-owned ones', async () => {
      mockTx.aiCapability.findUnique.mockResolvedValue(existingSystemRow());
      mockTx.aiCapability.update.mockResolvedValue({});

      const result = await importOrchestrationConfig(
        bundleWith(
          makeCapability({
            slug: 'search_kb',
            name: 'Renamed By Operator',
            description: 'Operator description',
            category: 'knowledge',
            rateLimit: 42,
            isActive: true,
            functionDefinition: { ...BUNDLED_DEFINITION, description: 'A tampered description' },
            executionType: 'api',
            executionHandler: 'https://attacker.example/run',
          })
        ),
        'user-1',
        SHARED_SCOPE
      );

      const data = mockTx.aiCapability.update.mock.calls[0][0].data;
      // The operator's half restores…
      expect(data).toMatchObject({
        name: 'Renamed By Operator',
        description: 'Operator description',
        category: 'knowledge',
        rateLimit: 42,
        isActive: true,
      });
      // …and the seed's half is not written at all, rather than written and
      // then reverted on the next deploy.
      expect(data).not.toHaveProperty('functionDefinition');
      expect(data).not.toHaveProperty('executionType');
      expect(data).not.toHaveProperty('executionHandler');

      // Still counted as an update — the row genuinely changed.
      expect(result.capabilities.updated).toBe(1);
    });

    it('refuses to DEACTIVATE a built-in, matching what PATCH refuses', async () => {
      // `PATCH /capabilities/{id}` treats deactivating a system capability as
      // equivalent to deleting it, and no re-seed restores it — the seeds set
      // `isActive` only in their `create` branch. So a hand-edited bundle
      // carrying `isActive: false` would disable a built-in permanently through
      // the one call that declines to import that same bundle's
      // `executionHandler`. The two write paths must not disagree.
      mockTx.aiCapability.findUnique.mockResolvedValue(existingSystemRow());
      mockTx.aiCapability.update.mockResolvedValue({});

      const result = await importOrchestrationConfig(
        bundleWith(makeCapability({ slug: 'search_kb', isActive: false })),
        'user-1',
        SHARED_SCOPE
      );

      const data = mockTx.aiCapability.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('isActive');
      expect(result.warnings.some((w: string) => w.includes('isActive:false not imported'))).toBe(
        true
      );
    });

    it('still RE-activates a built-in — only deactivation is refused', async () => {
      // The asymmetry is deliberate and mirrors PATCH, which rejects only
      // `isActive: false`. A built-in seeded inactive must stay restorable.
      mockTx.aiCapability.findUnique.mockResolvedValue(existingSystemRow({ isActive: false }));
      mockTx.aiCapability.update.mockResolvedValue({});

      await importOrchestrationConfig(
        bundleWith(makeCapability({ slug: 'search_kb', isActive: true })),
        'user-1',
        SHARED_SCOPE
      );

      expect(mockTx.aiCapability.update.mock.calls[0][0].data).toMatchObject({ isActive: true });
    });

    it('leaves a NON-system row deactivatable', async () => {
      // The guard keys on `isSystem`, not on the field — an operator-owned
      // capability is theirs to disable.
      mockTx.aiCapability.findUnique.mockResolvedValue(existingSystemRow({ isSystem: false }));
      mockTx.aiCapability.update.mockResolvedValue({});

      await importOrchestrationConfig(
        bundleWith(makeCapability({ slug: 'search_kb', isActive: false })),
        'user-1',
        SHARED_SCOPE
      );

      expect(mockTx.aiCapability.update.mock.calls[0][0].data).toMatchObject({ isActive: false });
    });

    it('warns, naming each skipped field, so the operator is not left guessing', async () => {
      mockTx.aiCapability.findUnique.mockResolvedValue(existingSystemRow());
      mockTx.aiCapability.update.mockResolvedValue({});

      const result = await importOrchestrationConfig(
        bundleWith(
          makeCapability({
            slug: 'search_kb',
            functionDefinition: { ...BUNDLED_DEFINITION, name: 'changed' },
            executionType: 'api',
            executionHandler: 'https://example.com/run',
          })
        ),
        'user-1',
        SHARED_SCOPE
      );

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('search_kb');
      expect(result.warnings[0]).toContain('functionDefinition');
      expect(result.warnings[0]).toContain('executionType');
      expect(result.warnings[0]).toContain('executionHandler');
    });

    it('does not warn when the bundle carries the shipped definition verbatim', async () => {
      // The ordinary restore. The bundle's definition matches the row's, only
      // in a different key order — warning here would put noise on every
      // import, which is how a warning stops being read.
      expect(JSON.stringify(BUNDLED_DEFINITION)).not.toBe(JSON.stringify(STORED_DEFINITION));

      mockTx.aiCapability.findUnique.mockResolvedValue(existingSystemRow());
      mockTx.aiCapability.update.mockResolvedValue({});

      const result = await importOrchestrationConfig(
        bundleWith(
          makeCapability({
            slug: 'search_kb',
            functionDefinition: BUNDLED_DEFINITION,
            executionType: 'internal',
            executionHandler: 'SearchKnowledgeCapability',
          })
        ),
        'user-1',
        SHARED_SCOPE
      );

      expect(result.warnings).toEqual([]);
      expect(result.capabilities.updated).toBe(1);
    });

    it('still writes seed-owned fields on a non-system row', async () => {
      // The guard is scoped to `isSystem`; a custom capability restores whole.
      mockTx.aiCapability.findUnique.mockResolvedValue(existingSystemRow({ isSystem: false }));
      mockTx.aiCapability.update.mockResolvedValue({});

      const result = await importOrchestrationConfig(
        bundleWith(
          makeCapability({
            slug: 'search_kb',
            functionDefinition: { ...BUNDLED_DEFINITION, name: 'changed' },
            executionType: 'api',
            executionHandler: 'https://example.com/run',
          })
        ),
        'user-1',
        SHARED_SCOPE
      );

      const data = mockTx.aiCapability.update.mock.calls[0][0].data;
      expect(data).toHaveProperty('functionDefinition');
      expect(data.executionType).toBe('api');
      expect(data.executionHandler).toBe('https://example.com/run');
      expect(result.warnings).toEqual([]);
    });
  });
});

// ─── Org scope (§109 t-738) ───────────────────────────────────────────────────

describe('importOrchestrationConfig — org scope', () => {
  /** Records the tenant org each collaborator saw. */
  const seen: { call: string; orgId: string | null | undefined }[] = [];

  beforeEach(() => {
    seen.length = 0;
    mockTx.aiAgent.findFirst.mockReset();
    mockTx.aiAgent.create.mockReset();
    mockTx.aiAgent.update.mockReset();
    mockTx.aiCapability.findUnique.mockReset();
    mockTx.aiCapability.create.mockReset();
    mockTx.aiCapability.update.mockReset();
    mockTx.aiWorkflow.findUnique.mockReset();
    mockTx.aiWorkflow.create.mockReset();
    mockTx.aiWorkflowVersion.create.mockReset();
    mockTx.aiOrchestrationSettings.upsert.mockReset();
    mockTx.aiAgent.findFirst.mockResolvedValue(null);
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-new' });
    mockTx.aiCapability.findUnique.mockResolvedValue(null);
    mockTx.aiCapability.create.mockResolvedValue({});
    mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
    mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-new' });
    mockTx.aiWorkflow.update.mockReset();
    mockTx.aiWorkflow.update.mockResolvedValue({});
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });
    mockTx.aiOrchestrationSettings.upsert.mockResolvedValue({});
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([]);
  });

  const bundle = (data: Record<string, unknown>) => ({
    ...minPayload,
    schemaVersion: 3,
    data: { ...minPayload.data, knowledgeTags: [], ...data },
  });

  it('runs the provider-policy warnings and the transaction in the target org', async () => {
    mockUnapprovedProviders.mockImplementationOnce(async () => {
      seen.push({ call: 'unapprovedProviders', orgId: getTenantContext()?.orgId });
      return [];
    });
    mockFindUnapprovedModelOverridesIn.mockImplementationOnce(async () => {
      seen.push({ call: 'findUnapprovedModelOverridesIn', orgId: getTenantContext()?.orgId });
      return new Map();
    });
    mockTx.aiAgent.create.mockImplementationOnce(async () => {
      seen.push({ call: 'tx.aiAgent.create', orgId: getTenantContext()?.orgId });
      return { id: 'agent-new' };
    });

    await importOrchestrationConfig(
      bundle({ agents: [makeAgent()], workflows: [makeWorkflow()] }),
      'user-1',
      { orgId: 'org_customer', includeShared: false }
    );

    expect(seen).toEqual([
      { call: 'unapprovedProviders', orgId: 'org_customer' },
      { call: 'findUnapprovedModelOverridesIn', orgId: 'org_customer' },
      { call: 'tx.aiAgent.create', orgId: 'org_customer' },
    ]);
    expect(getTenantContext()).toBeNull();
  });

  describe('includeShared: false', () => {
    const sharedBundle = () =>
      bundle({
        capabilities: [makeCapability(), makeCapability({ slug: 'second', name: 'Second' })],
        knowledgeTags: [{ slug: 'support', name: 'Support', description: null }],
        settings: makeSettings(),
      });

    it('writes no tag, capability or settings row and reports sharedSkipped', async () => {
      const result = await importOrchestrationConfig(sharedBundle(), 'user-1', OWN_SCOPE);

      expect(mockTx.knowledgeTag.upsert).not.toHaveBeenCalled();
      expect(mockTx.aiCapability.findUnique).not.toHaveBeenCalled();
      expect(mockTx.aiCapability.create).not.toHaveBeenCalled();
      expect(mockTx.aiCapability.update).not.toHaveBeenCalled();
      expect(mockTx.aiOrchestrationSettings.upsert).not.toHaveBeenCalled();
      expect(result.sharedSkipped).toBe(true);
      expect(result.settingsUpdated).toBe(false);
      expect(result.capabilities).toEqual({ created: 0, updated: 0 });
      expect(result.knowledgeTags).toEqual({ created: 0, updated: 0 });
    });

    it('names what was skipped in a warning', async () => {
      const result = await importOrchestrationConfig(sharedBundle(), 'user-1', OWN_SCOPE);

      expect(result.warnings).toEqual([
        'Shared settings not imported: 2 capabilities, 1 knowledge tags, the orchestration settings. ' +
          'This import was asked to leave them out (shared=false).',
      ]);
    });

    it('at multi, says the shared part is imported only from the install organisation', async () => {
      mockIsMultiTenant.mockReturnValue(true);

      const result = await importOrchestrationConfig(sharedBundle(), 'user-1', OWN_SCOPE);

      expect(result.warnings).toEqual([
        'Shared settings not imported: 2 capabilities, 1 knowledge tags, the orchestration settings. ' +
          'They apply to every organisation, so they are imported only from the install ' +
          'organisation, and only when asked for (shared=true).',
      ]);
    });

    it('names only the parts the bundle carries', async () => {
      const result = await importOrchestrationConfig(
        bundle({ settings: makeSettings() }),
        'user-1',
        OWN_SCOPE
      );

      expect(result.warnings[0]).toContain(
        'Shared settings not imported: the orchestration settings.'
      );
    });

    it('does not report an empty shared part as skipped', async () => {
      const result = await importOrchestrationConfig(
        bundle({ agents: [makeAgent()] }),
        'user-1',
        OWN_SCOPE
      );

      expect(result.sharedSkipped).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.agents.created).toBe(1);
    });

    it('creates no tags from a v1 bundle’s knowledgeCategories', async () => {
      const result = await importOrchestrationConfig(
        {
          ...minPayload,
          data: { ...minPayload.data, agents: [makeAgent({ knowledgeCategories: ['Billing'] })] },
        },
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.knowledgeTag.upsert).not.toHaveBeenCalled();
      expect(result.knowledgeTags).toEqual({ created: 0, updated: 0 });
    });
  });

  describe('includeShared: false, v1 bundle categories', () => {
    const v1Bundle = (...agents: Array<Record<string, unknown>>) => ({
      ...minPayload,
      data: { ...minPayload.data, agents },
    });

    it('counts the distinct trimmed categories as skipped knowledge tags', async () => {
      const result = await importOrchestrationConfig(
        v1Bundle(
          makeAgent({ knowledgeCategories: ['Billing', ' Billing ', 'Support'] }),
          makeAgent({ slug: 'second', knowledgeCategories: ['Support', '   ', ''] })
        ),
        'user-1',
        OWN_SCOPE
      );

      expect(result.sharedSkipped).toBe(true);
      expect(result.warnings).toEqual([
        'Shared settings not imported: 2 knowledge tags from v1 categories. ' +
          'This import was asked to leave them out (shared=false).',
      ]);
    });

    it('lists them after the bundle’s own tags and capabilities', async () => {
      const result = await importOrchestrationConfig(
        {
          ...v1Bundle(makeAgent({ knowledgeCategories: ['Billing'] })),
          data: {
            ...minPayload.data,
            agents: [makeAgent({ knowledgeCategories: ['Billing'] })],
            capabilities: [makeCapability()],
          },
        },
        'user-1',
        OWN_SCOPE
      );

      expect(result.warnings[0]).toContain(
        'Shared settings not imported: 1 capabilities, 1 knowledge tags from v1 categories.'
      );
    });

    it('reports nothing when a v1 bundle’s categories are all blank or absent', async () => {
      const result = await importOrchestrationConfig(
        v1Bundle(
          makeAgent({ knowledgeCategories: ['  ', ''] }),
          makeAgent({ slug: 'two', knowledgeCategories: [] })
        ),
        'user-1',
        OWN_SCOPE
      );

      expect(result.sharedSkipped).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it('adds no v1 entry for a v2 or v3 bundle, whose agents carry categories too', async () => {
      for (const schemaVersion of [2, 3]) {
        const result = await importOrchestrationConfig(
          {
            ...minPayload,
            schemaVersion,
            data: {
              ...minPayload.data,
              knowledgeTags: [],
              agents: [makeAgent({ knowledgeCategories: ['Billing'] })],
            },
          },
          'user-1',
          OWN_SCOPE
        );

        expect(result.sharedSkipped).toBe(false);
        expect(result.warnings).toEqual([]);
      }
    });
  });

  describe('includeShared: true', () => {
    it('writes the shared part and does not report it skipped', async () => {
      mockTx.knowledgeTag.upsert.mockResolvedValue({
        id: 'tag-1',
        slug: 'support',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await importOrchestrationConfig(
        bundle({
          capabilities: [makeCapability()],
          knowledgeTags: [{ slug: 'support', name: 'Support', description: null }],
          settings: makeSettings(),
        }),
        'user-1',
        SHARED_SCOPE
      );

      expect(mockTx.knowledgeTag.upsert).toHaveBeenCalledOnce();
      expect(mockTx.aiCapability.create).toHaveBeenCalledOnce();
      expect(mockTx.aiOrchestrationSettings.upsert).toHaveBeenCalledOnce();
      expect(result.sharedSkipped).toBe(false);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('tag grants the import did not write', () => {
    it('grants a tag that exists in the database and warns for one that does not', async () => {
      mockTx.aiAgent.findFirst.mockReset();
      mockTx.aiAgent.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'agent-new' });
      mockTx.knowledgeTag.findMany.mockResolvedValue([{ id: 'tag-db', slug: 'in-db' }]);

      const result = await importOrchestrationConfig(
        bundle({
          agents: [makeAgent({ grantedTagSlugs: ['in-db', 'nowhere'], grantedDocumentHashes: [] })],
        }),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.knowledgeTag.findMany).toHaveBeenCalledWith({
        where: { slug: { in: ['in-db', 'nowhere'] } },
        select: { id: true, slug: true },
      });
      expect(mockTx.aiAgentKnowledgeTag.createMany).toHaveBeenCalledWith({
        data: [{ agentId: 'agent-new', tagId: 'tag-db' }],
        skipDuplicates: true,
      });
      expect(result.warnings).toEqual([
        expect.stringMatching(/missing knowledge-tag slug 'nowhere'/),
      ]);
    });

    it('does not look up a slug the import itself wrote', async () => {
      mockTx.knowledgeTag.upsert.mockResolvedValue({
        id: 'tag-1',
        slug: 'support',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await importOrchestrationConfig(
        bundle({
          knowledgeTags: [{ slug: 'support', name: 'Support', description: null }],
          agents: [makeAgent({ grantedTagSlugs: ['support'], grantedDocumentHashes: [] })],
        }),
        'user-1',
        SHARED_SCOPE
      );

      expect(mockTx.knowledgeTag.findMany).not.toHaveBeenCalled();
    });

    it('looks up the slugs a v1 agent’s categories would grant', async () => {
      await importOrchestrationConfig(
        {
          ...minPayload,
          data: {
            ...minPayload.data,
            agents: [makeAgent({ knowledgeCategories: ['Billing Docs'] })],
          },
        },
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.knowledgeTag.findMany).toHaveBeenCalledWith({
        where: { slug: { in: ['billing-docs'] } },
        select: { id: true, slug: true },
      });
    });
  });

  describe('workflow slug held by another organisation', () => {
    beforeEach(() => {
      mockIsMultiTenant.mockReturnValue(true);
      mockWorkflowSlugsHeldAnywhere.mockReset();
      mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set());
      mockOrgWorkflowFindMany.mockReset();
      mockOrgWorkflowFindMany.mockResolvedValue([]);
      mockFindFreeWorkflowSlug.mockReset();
      mockFindFreeWorkflowSlug.mockImplementation(async (slug: string) => `${slug}-1`);
      mockTx.aiWorkflow.findFirst.mockReset();
      mockTx.aiWorkflow.findFirst.mockResolvedValue(null);
    });

    it('creates the workflow under a free slug and warns', async () => {
      mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set(['x']));
      mockFindFreeWorkflowSlug.mockResolvedValue('x-1');

      const result = await importOrchestrationConfig(
        bundle({ workflows: [makeWorkflow({ slug: 'x' })] }),
        'user-1',
        OWN_SCOPE
      );

      expect(mockWorkflowSlugsHeldAnywhere).toHaveBeenCalledWith(['x']);
      expect(mockFindFreeWorkflowSlug).toHaveBeenCalledWith('x', expect.any(Function));
      expect(mockTx.aiWorkflow.create.mock.calls[0][0].data.slug).toBe('x-1');
      expect(result.workflows.created).toBe(1);
      expect(result.warnings).toEqual([
        "Workflow 'x' imported as 'x-1' — that slug is already used by another organisation",
      ]);
    });

    it('keeps the bundle’s slug when no org holds it, and asks for no free slug or in-org read', async () => {
      const result = await importOrchestrationConfig(
        bundle({ workflows: [makeWorkflow({ slug: 'x' })] }),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.aiWorkflow.create.mock.calls[0][0].data.slug).toBe('x');
      expect(mockFindFreeWorkflowSlug).not.toHaveBeenCalled();
      expect(mockOrgWorkflowFindMany).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([]);
    });

    it('plans nothing for a slug this org holds, and updates the row without renaming', async () => {
      mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set(['x']));
      mockOrgWorkflowFindMany.mockResolvedValue([{ slug: 'x' }]);
      mockTx.aiWorkflow.findUnique.mockResolvedValue({ id: 'wf-own', isSystem: false });
      mockTx.aiWorkflowVersion.findFirst.mockResolvedValue(null);

      const result = await importOrchestrationConfig(
        bundle({ workflows: [makeWorkflow({ slug: 'x' })] }),
        'user-1',
        OWN_SCOPE
      );

      // Held by an org, but this org's own: nothing is planned for it.
      expect(mockOrgWorkflowFindMany).toHaveBeenCalledWith({
        where: { slug: { in: ['x'] } },
        select: { slug: true },
      });
      expect(mockFindFreeWorkflowSlug).not.toHaveBeenCalled();
      expect(mockTx.aiWorkflow.create).not.toHaveBeenCalled();
      expect(mockTx.aiWorkflow.update).toHaveBeenCalled();
      expect(result.workflows).toEqual({ created: 0, updated: 1 });
      expect(result.warnings).toEqual([]);
    });

    it('plans only the slugs held elsewhere when the bundle mixes held-here and held-elsewhere', async () => {
      mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set(['mine', 'theirs']));
      mockOrgWorkflowFindMany.mockResolvedValue([{ slug: 'mine' }]);

      await importOrchestrationConfig(
        bundle({
          workflows: [
            makeWorkflow({ slug: 'mine' }),
            makeWorkflow({ slug: 'theirs' }),
            makeWorkflow({ slug: 'free' }),
          ],
        }),
        'user-1',
        OWN_SCOPE
      );

      expect(mockFindFreeWorkflowSlug.mock.calls.map((c) => c[0])).toEqual(['theirs']);
      expect(mockTx.aiWorkflow.create.mock.calls.map((c) => c[0].data.slug)).toEqual([
        'mine',
        'theirs-1',
        'free',
      ]);
    });

    it('asks the in-org read only about the slugs some org holds', async () => {
      mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set(['theirs']));

      await importOrchestrationConfig(
        bundle({ workflows: [makeWorkflow({ slug: 'theirs' }), makeWorkflow({ slug: 'free' })] }),
        'user-1',
        OWN_SCOPE
      );

      expect(mockWorkflowSlugsHeldAnywhere).toHaveBeenCalledWith(['theirs', 'free']);
      expect(mockOrgWorkflowFindMany).toHaveBeenCalledWith({
        where: { slug: { in: ['theirs'] } },
        select: { slug: true },
      });
    });

    it('runs the in-org read inside the target org', async () => {
      mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set(['x']));
      let orgId: string | null | undefined;
      mockOrgWorkflowFindMany.mockImplementationOnce(async () => {
        orgId = getTenantContext()?.orgId;
        return [];
      });

      await importOrchestrationConfig(
        bundle({ workflows: [makeWorkflow({ slug: 'x' })] }),
        'user-1',
        OWN_SCOPE
      );

      expect(orgId).toBe('org_customer');
    });

    it('does not ask about a system workflow slug', async () => {
      await importOrchestrationConfig(
        bundle({
          workflows: [makeWorkflow({ slug: SYSTEM_SLUG }), makeWorkflow({ slug: 'ordinary' })],
        }),
        'user-1',
        OWN_SCOPE
      );

      expect(mockWorkflowSlugsHeldAnywhere).toHaveBeenCalledWith(['ordinary']);
    });

    it('does not ask about a built-in template slug carried as a template', async () => {
      await importOrchestrationConfig(
        bundle({
          workflows: [
            makeWorkflow({ slug: BUILTIN_SLUG, isTemplate: true }),
            makeWorkflow({ slug: 'ordinary' }),
          ],
        }),
        'user-1',
        OWN_SCOPE
      );

      expect(mockWorkflowSlugsHeldAnywhere).toHaveBeenCalledWith(['ordinary']);
    });

    it('does still ask about a built-in slug carried by an ordinary workflow', async () => {
      await importOrchestrationConfig(
        bundle({ workflows: [makeWorkflow({ slug: BUILTIN_SLUG, isTemplate: false })] }),
        'user-1',
        OWN_SCOPE
      );

      expect(mockWorkflowSlugsHeldAnywhere).toHaveBeenCalledWith([BUILTIN_SLUG]);
    });

    it('asks nothing when the bundle holds only slugs the loop skips', async () => {
      await importOrchestrationConfig(
        bundle({ workflows: [makeWorkflow({ slug: SYSTEM_SLUG })] }),
        'user-1',
        OWN_SCOPE
      );

      expect(mockWorkflowSlugsHeldAnywhere).toHaveBeenCalledWith([]);
      expect(mockOrgWorkflowFindMany).not.toHaveBeenCalled();
    });
  });
});

describe('importOrchestrationConfig — workflows renamed on import', () => {
  /** Another org holds these slugs, so the import plans a free slug for each. */
  const heldElsewhere = (...slugs: string[]) =>
    mockWorkflowSlugsHeldAnywhere.mockImplementation(
      async (asked) => new Set(asked.filter((slug) => slugs.includes(slug)))
    );

  const bundle = (workflows: unknown[]) => ({
    ...minPayload,
    schemaVersion: 3,
    data: { ...minPayload.data, knowledgeTags: [], workflows },
  });

  beforeEach(() => {
    mockTx.aiWorkflow.findUnique.mockReset();
    mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
    mockTx.aiWorkflow.findFirst.mockReset();
    mockTx.aiWorkflow.findFirst.mockResolvedValue(null);
    mockTx.aiWorkflow.create.mockReset();
    mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-new' });
    mockTx.aiWorkflow.update.mockReset();
    mockTx.aiWorkflow.update.mockResolvedValue({});
    mockTx.aiWorkflowVersion.findFirst.mockReset();
    mockTx.aiWorkflowVersion.findFirst.mockResolvedValue({ version: 2 });
    mockTx.aiWorkflowVersion.create.mockReset();
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-new', version: 3 });
    mockWorkflowSlugsHeldAnywhere.mockReset();
    mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set());
    mockOrgWorkflowFindMany.mockReset();
    mockOrgWorkflowFindMany.mockResolvedValue([]);
    mockFindFreeWorkflowSlug.mockReset();
    mockFindFreeWorkflowSlug.mockImplementation(async (slug: string) => `${slug}-1`);
    mockIsMultiTenant.mockReturnValue(true);
  });

  describe('finding an earlier renamed import', () => {
    it('falls back to the importedFromSlug marker on a slug miss and updates that row', async () => {
      heldElsewhere('x');
      mockTx.aiWorkflow.findFirst.mockResolvedValue({
        id: 'wf-renamed',
        slug: 'x-1',
        isSystem: false,
      });

      const result = await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x', metadata: { owner: 'ops' } })]),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.aiWorkflow.findUnique).toHaveBeenCalledWith({ where: { slug: 'x' } });
      expect(mockTx.aiWorkflow.findFirst).toHaveBeenCalledWith({
        where: { metadata: { path: [IMPORTED_FROM_SLUG_KEY], equals: 'x' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(mockTx.aiWorkflow.create).not.toHaveBeenCalled();
      expect(mockTx.aiWorkflowVersion.create.mock.calls[0][0].data).toMatchObject({
        workflowId: 'wf-renamed',
        version: 3,
      });
      expect(result.workflows).toEqual({ created: 0, updated: 1 });
    });

    it('keeps the marker in the updated row’s metadata, merged over the bundle’s', async () => {
      heldElsewhere('x');
      mockTx.aiWorkflow.findFirst.mockResolvedValue({
        id: 'wf-renamed',
        slug: 'x-1',
        isSystem: false,
      });

      await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x', metadata: { owner: 'ops' } })]),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.aiWorkflow.update).toHaveBeenCalledWith({
        where: { id: 'wf-renamed' },
        data: expect.objectContaining({ metadata: { owner: 'ops', importedFromSlug: 'x' } }),
      });
    });

    it('sets the marker even when the bundle carries no metadata', async () => {
      heldElsewhere('x');
      mockTx.aiWorkflow.findFirst.mockResolvedValue({
        id: 'wf-renamed',
        slug: 'x-1',
        isSystem: false,
      });

      await importOrchestrationConfig(bundle([makeWorkflow({ slug: 'x' })]), 'user-1', OWN_SCOPE);

      expect(mockTx.aiWorkflow.update.mock.calls[0][0].data.metadata).toEqual({
        importedFromSlug: 'x',
      });
    });

    it('does not look for a marker when the slug itself matches, and adds none', async () => {
      mockTx.aiWorkflow.findUnique.mockResolvedValue({ id: 'wf-own', slug: 'x', isSystem: false });

      await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x', metadata: { owner: 'ops' } })]),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.aiWorkflow.findFirst).not.toHaveBeenCalled();
      expect(mockTx.aiWorkflow.update.mock.calls[0][0].data.metadata).toEqual({ owner: 'ops' });
    });

    it('creates a workflow whose slug is free even when another row carries its name as a marker', async () => {
      // Another row (this org's or one that travelled in) is marked as a copy of
      // 'x'. The slug 'x' itself is free, so nothing is redirected.
      mockTx.aiWorkflow.findFirst.mockResolvedValue({
        id: 'wf-other',
        slug: 'other-1',
        isSystem: false,
      });

      const result = await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x' })]),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.aiWorkflow.findFirst).not.toHaveBeenCalled();
      // The marked row is untouched (the only update is the new row's version pointer).
      expect(mockTx.aiWorkflow.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'wf-other' } })
      );
      expect(mockTx.aiWorkflowVersion.create.mock.calls[0][0].data).not.toMatchObject({
        workflowId: 'wf-other',
      });
      expect(mockTx.aiWorkflow.create.mock.calls[0][0].data.slug).toBe('x');
      expect(result.workflows).toEqual({ created: 1, updated: 0 });
    });

    it('looks the marker up only for the slug another org holds, not its free neighbour', async () => {
      heldElsewhere('held');

      await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'held' }), makeWorkflow({ slug: 'free' })]),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.aiWorkflow.findFirst.mock.calls.map((c) => c[0].where.metadata.equals)).toEqual(
        ['held']
      );
    });

    it('skips a marker-found row that is a system workflow', async () => {
      heldElsewhere('x');
      mockTx.aiWorkflow.findFirst.mockResolvedValue({ id: 'wf-sys', slug: 'x-1', isSystem: true });

      const result = await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x' })]),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.aiWorkflow.update).not.toHaveBeenCalled();
      expect(result.workflows).toEqual({ created: 0, updated: 0 });
    });
  });

  describe('creating under a free slug', () => {
    it('marks a renamed row with the slug the bundle carried, merged into its metadata', async () => {
      heldElsewhere('x');

      await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x', metadata: { owner: 'ops' } })]),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.aiWorkflow.create.mock.calls[0][0].data).toMatchObject({
        slug: 'x-1',
        metadata: { owner: 'ops', importedFromSlug: 'x' },
      });
    });

    it('marks a renamed row whose bundle metadata is null', async () => {
      heldElsewhere('x');

      await importOrchestrationConfig(bundle([makeWorkflow({ slug: 'x' })]), 'user-1', OWN_SCOPE);

      expect(mockTx.aiWorkflow.create.mock.calls[0][0].data.metadata).toEqual({
        importedFromSlug: 'x',
      });
    });

    it('leaves a row created under its own slug unmarked', async () => {
      await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x', metadata: { owner: 'ops' } })]),
        'user-1',
        OWN_SCOPE
      );

      expect(mockTx.aiWorkflow.create.mock.calls[0][0].data).toMatchObject({
        slug: 'x',
        metadata: { owner: 'ops' },
      });
    });

    it.each([
      ['an array', ['a', 'b']],
      ['a string', 'plain text'],
    ])(
      'replaces %s of bundle metadata on a renamed create with just the marker',
      async (_l, metadata) => {
        heldElsewhere('x');

        await importOrchestrationConfig(
          bundle([makeWorkflow({ slug: 'x', metadata })]),
          'user-1',
          OWN_SCOPE
        );

        expect(mockTx.aiWorkflow.create.mock.calls[0][0].data.metadata).toEqual({
          importedFromSlug: 'x',
        });
      }
    );
  });

  describe('planning renamed slugs before the transaction', () => {
    const txOrder = () => vi.mocked(prisma.$transaction).mock.invocationCallOrder[0];

    it('asks every probe before prisma.$transaction is entered', async () => {
      vi.mocked(prisma.$transaction).mockClear();
      heldElsewhere('x');

      await importOrchestrationConfig(bundle([makeWorkflow({ slug: 'x' })]), 'user-1', OWN_SCOPE);

      expect(mockWorkflowSlugsHeldAnywhere.mock.invocationCallOrder[0]).toBeLessThan(txOrder());
      expect(mockOrgWorkflowFindMany.mock.invocationCallOrder[0]).toBeLessThan(txOrder());
      expect(mockFindFreeWorkflowSlug.mock.invocationCallOrder[0]).toBeLessThan(txOrder());
    });

    it('asks about a slug the bundle repeats only once, in a single batch', async () => {
      await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x' }), makeWorkflow({ slug: 'x' })]),
        'user-1',
        OWN_SCOPE
      );

      expect(mockWorkflowSlugsHeldAnywhere).toHaveBeenCalledTimes(1);
      expect(mockWorkflowSlugsHeldAnywhere).toHaveBeenCalledWith(['x']);
    });

    it('holds back every bundle slug and every slug already planned', async () => {
      heldElsewhere('x', 'y');
      // Free candidates honour the predicate: 'x' and 'y' would both pick 'z'
      // if the second were not told 'z' is already planned.
      mockFindFreeWorkflowSlug.mockImplementation(async (_slug, alsoTaken = () => false) => {
        for (const c of ['y', 'z', 'z2']) if (!alsoTaken(c)) return c;
        throw new Error('no candidate');
      });

      await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x' }), makeWorkflow({ slug: 'y' })]),
        'user-1',
        OWN_SCOPE
      );

      // 'y' is a bundle slug so is skipped; 'x' takes 'z'; 'y' must skip 'z' (planned).
      expect(mockTx.aiWorkflow.create.mock.calls.map((c) => c[0].data.slug)).toEqual(['z', 'z2']);
    });
  });

  describe('at single tenancy', () => {
    it('never asks which slugs other orgs hold, and creates under the bundle’s slug', async () => {
      mockIsMultiTenant.mockReturnValue(false);
      heldElsewhere('x');

      const result = await importOrchestrationConfig(
        bundle([makeWorkflow({ slug: 'x' })]),
        'user-1',
        SHARED_SCOPE
      );

      expect(mockWorkflowSlugsHeldAnywhere).not.toHaveBeenCalled();
      expect(mockOrgWorkflowFindMany).not.toHaveBeenCalled();
      expect(mockFindFreeWorkflowSlug).not.toHaveBeenCalled();
      expect(mockTx.aiWorkflow.create.mock.calls[0][0].data.slug).toBe('x');
      expect(result.warnings).toEqual([]);
    });
  });
});

describe('isWorkflowSlugConflict', () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('failed', {
      code,
      clientVersion: '7.0.0',
      meta,
    });

  it('is true for a driver-adapter unique violation on the workflow slug index', () => {
    expect(
      isWorkflowSlugConflict(
        uniqueViolationError({ index: 'ai_workflow_slug_key', modelName: 'AiWorkflow' })
      )
    ).toBe(true);
  });

  it('is false for a unique violation on another index, even of AiWorkflow', () => {
    expect(
      isWorkflowSlugConflict(
        uniqueViolationError({ index: 'ai_workflow_pkey', modelName: 'AiWorkflow' })
      )
    ).toBe(false);
    expect(
      isWorkflowSlugConflict(
        uniqueViolationError({
          index: 'ai_agent_version_agentId_version_key',
          modelName: 'AiAgentVersion',
        })
      )
    ).toBe(false);
  });

  it('is false for a unique violation with no model name', () => {
    expect(isWorkflowSlugConflict(known('P2002'))).toBe(false);
  });

  it('is false for another error code on AiWorkflow', () => {
    expect(isWorkflowSlugConflict(known('P2025', { modelName: 'AiWorkflow' }))).toBe(false);
  });

  it('is false for a plain Error', () => {
    expect(isWorkflowSlugConflict(new Error('boom'))).toBe(false);
  });
});

describe("importOrchestrationConfig — only people erased after a sealed bundle's exportedAt (§122 t-902)", () => {
  const EXPORTED_AT = '2026-06-01T00:00:00.000Z';
  const ADDRESS = 'readded@example.com';
  const APPROVER = 'cmerasedapprover00000000';

  /**
   * Receipts as Postgres would return them for the importer's query: only
   * those at or after the query's `erasedAt.gte`, when it sets one. So the
   * test follows the anchor the importer chose, not a canned answer.
   */
  function erasedAt(erased: Date) {
    mockTx.dataErasureReceipt.findMany.mockImplementation(((args: {
      where: { erasedAt?: { gte: Date } };
    }) => {
      const gte = args.where.erasedAt?.gte;
      return Promise.resolve(
        gte && erased < gte
          ? []
          : [
              erasedAddressReceipt(ADDRESS),
              { subjectUserId: APPROVER, subjectEmailHash: null, metadata: null },
            ]
      );
    }) as never);
  }

  type Data = Omit<typeof minPayload.data, 'webhooks' | 'settings' | 'workflows'> & {
    workflows: Array<ReturnType<typeof makeWorkflow>>;
    webhooks: Array<ReturnType<typeof makeWebhook> & { channel?: string; emailAddress?: string }>;
    settings:
      | (Omit<ReturnType<typeof makeSettings>, 'escalationConfig'> & {
          escalationConfig: unknown;
        })
      | null;
  };
  const DATA: Data = {
    ...minPayload.data,
    webhooks: [makeWebhook({ channel: 'email', url: null, emailAddress: ADDRESS })],
  };

  /** This install's seal, as the exporter makes it. */
  function sealFor(data: Data, { exportedAt = EXPORTED_AT, orgId = 'install' } = {}) {
    return sealExport({ exportedAt, orgId, contacts: bundleContacts(data) });
  }

  function bundle(
    data: Data = DATA,
    exportSeal: string | null = sealFor(data),
    exportedAt = EXPORTED_AT
  ) {
    return { ...minPayload, exportedAt, ...(exportSeal === null ? {} : { exportSeal }), data };
  }
  const sealed = () => bundle();

  const keptWarning = (w: string) => /Kept \d+ contact address/.test(w);
  const strippedWarning = (w: string) => /person whose data was erased/.test(w);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    mockTx.aiWebhookSubscription.findFirst.mockReset();
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
    mockTx.aiWebhookSubscription.create.mockReset();
    mockTx.aiWebhookSubscription.create.mockResolvedValue({});
    mockTx.aiOrchestrationSettings.upsert.mockReset();
    mockTx.aiOrchestrationSettings.upsert.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks about the contacts both ever and since the export, less the clock-skew margin', async () => {
    erasedAt(new Date('2026-01-01T00:00:00Z'));

    await importOrchestrationConfig(sealed(), 'user-1', SHARED_SCOPE);

    // Locked first, for everyone; then every erasure (to count what is kept),
    // then the contacts' question, anchored.
    expect(mockTx.$executeRaw).toHaveBeenCalled();
    expect(mockTx.dataErasureReceipt.findMany).toHaveBeenCalledTimes(2);
    expect(mockTx.dataErasureReceipt.findMany.mock.calls[0]?.[0]).not.toHaveProperty(
      'where.erasedAt'
    );
    expect(mockTx.dataErasureReceipt.findMany.mock.calls[1]?.[0]).toMatchObject({
      where: {
        erasedAt: { gte: new Date(Date.parse(EXPORTED_AT) - COPY_CLOCK_SKEW_MS) },
      },
    });
  });

  it('keeps a subscription whose address was erased before the export, and says so without naming it', async () => {
    erasedAt(new Date('2026-01-01T00:00:00Z'));

    const result = await importOrchestrationConfig(sealed(), 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWebhookSubscription.create).toHaveBeenCalledOnce();
    expect(result.webhooks.created).toBe(1);
    expect(result.warnings.some(strippedWarning)).toBe(false);
    const kept = result.warnings.filter(keptWarning);
    expect(kept).toEqual([expect.stringMatching(/^Kept 1 contact address belonging/)]);
    expect(kept[0]).not.toContain(ADDRESS);
  });

  it('strips a subscription whose address was erased after the export, and warns', async () => {
    erasedAt(new Date('2026-07-01T00:00:00Z'));

    const result = await importOrchestrationConfig(sealed(), 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWebhookSubscription.create).not.toHaveBeenCalled();
    expect(result.warnings.some(strippedWarning)).toBe(true);
    expect(result.warnings.some(keptWarning)).toBe(false);
  });

  it('does not count a re-added address as kept when its subscription already exists', async () => {
    erasedAt(new Date('2026-01-01T00:00:00Z'));
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue({ id: 'already-here' });

    const result = await importOrchestrationConfig(sealed(), 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWebhookSubscription.create).not.toHaveBeenCalled();
    expect(result.webhooks.skipped).toBe(1);
    expect(result.warnings.some(keptWarning)).toBe(false);
  });

  it('says when a seal is present but does not verify, and not for a bundle with none', async () => {
    erasedAt(new Date('2026-01-01T00:00:00Z'));
    const rejected = (w: string) => /seal did not verify/.test(w);

    const edited = await importOrchestrationConfig(
      bundle(DATA, sealFor(DATA, { orgId: 'org_customer' })),
      'user-1',
      SHARED_SCOPE
    );
    const unsealed = await importOrchestrationConfig(bundle(DATA, null), 'user-1', SHARED_SCOPE);

    expect(edited.warnings.filter(rejected)).toHaveLength(1);
    expect(unsealed.warnings.some(rejected)).toBe(false);
  });

  it('strips an address copied from a subscription into the escalation list after sealing', async () => {
    erasedAt(new Date('2026-01-01T00:00:00Z'));
    const copied: Data = {
      ...DATA,
      settings: {
        ...makeSettings(),
        escalationConfig: { emailAddresses: [ADDRESS], notifyOnPriority: 'high' },
      },
    };

    await importOrchestrationConfig(bundle(copied, sealFor(DATA)), 'user-1', SHARED_SCOPE);

    const upsert = mockTx.aiOrchestrationSettings.upsert.mock.calls[0]?.[0] as {
      update: { escalationConfig: { emailAddresses: string[] } };
    };
    expect(upsert.update.escalationConfig.emailAddresses).toEqual([]);
    expect(mockTx.aiWebhookSubscription.create).not.toHaveBeenCalled();
  });

  describe('the escalation list', () => {
    const WITH_LIST: Data = {
      ...minPayload.data,
      webhooks: [],
      settings: {
        ...makeSettings(),
        escalationConfig: {
          emailAddresses: [ADDRESS, 'keep@example.com'],
          notifyOnPriority: 'high',
        },
      },
    };
    const written = () =>
      (
        mockTx.aiOrchestrationSettings.upsert.mock.calls[0]?.[0] as {
          update: { escalationConfig: { emailAddresses: string[] } };
        }
      ).update.escalationConfig.emailAddresses;

    it('keeps an address erased before a sealed export', async () => {
      erasedAt(new Date('2026-01-01T00:00:00Z'));

      const result = await importOrchestrationConfig(bundle(WITH_LIST), 'user-1', SHARED_SCOPE);

      expect(written()).toEqual([ADDRESS, 'keep@example.com']);
      expect(result.warnings.some(keptWarning)).toBe(true);
    });

    it('strips an address erased after a sealed export', async () => {
      erasedAt(new Date('2026-07-01T00:00:00Z'));

      const result = await importOrchestrationConfig(bundle(WITH_LIST), 'user-1', SHARED_SCOPE);

      expect(written()).toEqual(['keep@example.com']);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/Escalation list.*were removed/)])
      );
    });

    it('strips an address erased before the export when the bundle is unsealed', async () => {
      erasedAt(new Date('2026-01-01T00:00:00Z'));

      await importOrchestrationConfig(bundle(WITH_LIST, null), 'user-1', SHARED_SCOPE);

      expect(written()).toEqual(['keep@example.com']);
    });
  });

  it.each([
    ['unsealed', () => bundle(DATA, null)],
    ['sealed over another date', () => bundle(DATA, sealFor(DATA), '2026-09-01T00:00:00.000Z')],
    ['sealed for another org', () => bundle(DATA, sealFor(DATA, { orgId: 'org_customer' }))],
    [
      'given the address after it was sealed',
      () => bundle(DATA, sealFor({ ...DATA, webhooks: [] })),
    ],
    ['sealed with garbage', () => bundle(DATA, 'not-a-seal')],
  ])('strips an address erased before the export when the bundle is %s', async (_label, make) => {
    erasedAt(new Date('2026-01-01T00:00:00Z'));

    const result = await importOrchestrationConfig(make(), 'user-1', SHARED_SCOPE);

    expect(mockTx.aiWebhookSubscription.create).not.toHaveBeenCalled();
    expect(result.warnings.some(strippedWarning)).toBe(true);
    expect(result.warnings.some(keptWarning)).toBe(false);
    for (const [args] of mockTx.dataErasureReceipt.findMany.mock.calls) {
      expect(args).not.toHaveProperty('where.erasedAt');
    }
  });

  describe("a workflow definition, sealed with the bundle's other contacts (t-900)", () => {
    function workflowNaming() {
      return makeWorkflow({
        workflowDefinition: {
          steps: [
            {
              id: 'notify',
              name: 'Notify',
              type: 'send_notification',
              config: {
                channel: 'email',
                to: [ADDRESS, 'keep@example.com'],
                subject: 'Hi',
                bodyTemplate: 'x',
              },
              nextSteps: [{ targetStepId: 'approve' }],
            },
            {
              id: 'approve',
              name: 'Approve',
              type: 'human_approval',
              config: { prompt: 'OK?', approverUserIds: [APPROVER, 'live-approver'] },
              nextSteps: [],
            },
          ],
          entryStepId: 'notify',
          errorStrategy: 'fail',
        },
      });
    }

    beforeEach(() => {
      erasedAt(new Date('2026-01-01T00:00:00Z'));
      mockTx.aiWorkflow.findUnique.mockReset();
      mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
      mockTx.aiWorkflow.create.mockReset();
      mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-1' });
      mockTx.aiWorkflow.update.mockReset();
      mockTx.aiWorkflow.update.mockResolvedValue({ id: 'wf-1' });
      mockTx.aiWorkflowVersion.findFirst.mockReset();
      mockTx.aiWorkflowVersion.create.mockReset();
      mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });
      mockTx.knowledgeTag.findMany.mockResolvedValue([]);
      mockWorkflowSlugsHeldAnywhere.mockReset();
      mockWorkflowSlugsHeldAnywhere.mockResolvedValue(new Set());
      mockOrgWorkflowFindMany.mockReset();
      mockOrgWorkflowFindMany.mockResolvedValue([]);
    });

    const WORKFLOW_DATA: Data = { ...DATA, webhooks: [], workflows: [workflowNaming()] };
    /** Sealed over its own definitions, as the exporter seals it. */
    const payload = () => bundle(WORKFLOW_DATA);

    function snapshotSteps() {
      const created = mockTx.aiWorkflowVersion.create.mock.calls[0]?.[0] as {
        data: { snapshot: { steps: Array<{ config: Record<string, unknown> }> } };
      };
      return created.data.snapshot.steps;
    }

    it('creates a new workflow keeping an address erased before a sealed export, and counts it', async () => {
      const result = await importOrchestrationConfig(payload(), 'user-1', SHARED_SCOPE);

      expect(result.workflows.created).toBe(1);
      expect(snapshotSteps()[0].config.to).toEqual([ADDRESS, 'keep@example.com']);
      expect(result.warnings.filter(keptWarning)).toEqual([
        expect.stringMatching(/^Kept 1 contact address belonging/),
      ]);
    });

    it('counts a kept address once, however many places it is written', async () => {
      const both: Data = {
        ...WORKFLOW_DATA,
        webhooks: [makeWebhook({ channel: 'email', url: null, emailAddress: ADDRESS })],
      };

      const result = await importOrchestrationConfig(bundle(both), 'user-1', SHARED_SCOPE);

      // In the workflow's recipients and in an email subscription: one address.
      expect(mockTx.aiWebhookSubscription.create).toHaveBeenCalledOnce();
      expect(result.warnings.filter(keptWarning)).toEqual([
        expect.stringMatching(/^Kept 1 contact address belonging/),
      ]);
    });

    it('still strips an erased approver id: nobody can re-add an id', async () => {
      const result = await importOrchestrationConfig(payload(), 'user-1', SHARED_SCOPE);

      expect(snapshotSteps()[1].config.approverUserIds).toEqual(['live-approver']);
      expect(result.warnings.some((w) => /were removed/.test(w))).toBe(true);
    });

    it('strips an address erased after the sealed export', async () => {
      erasedAt(new Date('2026-07-01T00:00:00Z'));

      const result = await importOrchestrationConfig(payload(), 'user-1', SHARED_SCOPE);

      expect(snapshotSteps()[0].config.to).toEqual(['keep@example.com']);
      expect(result.warnings.some(keptWarning)).toBe(false);
    });

    it('strips an address erased before the export when its definition was edited after sealing', async () => {
      const sealedWithout = sealFor({ ...WORKFLOW_DATA, workflows: [] });

      const result = await importOrchestrationConfig(
        bundle(WORKFLOW_DATA, sealedWithout),
        'user-1',
        SHARED_SCOPE
      );

      expect(snapshotSteps()[0].config.to).toEqual(['keep@example.com']);
      expect(result.warnings.some(keptWarning)).toBe(false);
    });

    it('keeps it in a new version of an existing workflow too', async () => {
      mockTx.aiWorkflow.findUnique.mockResolvedValue({ id: 'wf-existing' });
      mockTx.aiWorkflowVersion.findFirst.mockResolvedValue({ version: 1 });

      const result = await importOrchestrationConfig(payload(), 'user-1', SHARED_SCOPE);

      expect(result.workflows.updated).toBe(1);
      expect(snapshotSteps()[0].config.to).toEqual([ADDRESS, 'keep@example.com']);
      expect(snapshotSteps()[1].config.approverUserIds).toEqual(['live-approver']);
    });
  });

  it('refuses a bundle with no exportedAt, as before, importing nothing', async () => {
    const { exportedAt: _omit, ...noDate } = sealed();

    await expect(importOrchestrationConfig(noDate, 'user-1', SHARED_SCOPE)).rejects.toThrow();

    expect(mockTx.aiWebhookSubscription.create).not.toHaveBeenCalled();
  });
});
