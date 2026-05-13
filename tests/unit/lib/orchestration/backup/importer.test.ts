/**
 * Tests for `lib/orchestration/backup/importer.ts`
 *
 * Verifies that importOrchestrationConfig() validates the schema,
 * upserts records by slug, skips duplicate webhooks, and reports results.
 *
 * @see lib/orchestration/backup/importer.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

const mockTx = {
  aiAgent: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  aiCapability: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  aiWorkflow: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  aiWorkflowVersion: { findFirst: vi.fn(), create: vi.fn() },
  aiWebhookSubscription: { findFirst: vi.fn(), create: vi.fn() },
  aiOrchestrationSettings: { upsert: vi.fn() },
  knowledgeTag: { upsert: vi.fn() },
  aiAgentKnowledgeTag: { deleteMany: vi.fn(), createMany: vi.fn() },
  aiAgentKnowledgeDocument: { deleteMany: vi.fn(), createMany: vi.fn() },
  aiKnowledgeDocument: { findMany: vi.fn() },
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $transaction: vi.fn((fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { importOrchestrationConfig } from '@/lib/orchestration/backup/importer';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

describe('importOrchestrationConfig', () => {
  beforeEach(() => {
    // Reset individual tx mock methods — do NOT use vi.resetAllMocks() here because
    // that would also clear the prisma.$transaction implementation set at module level.
    mockTx.aiAgent.findUnique.mockReset();
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
  });

  it('throws ZodError when schema is invalid (wrong schemaVersion)', async () => {
    const invalidPayload = { ...minPayload, schemaVersion: 99 };

    await expect(importOrchestrationConfig(invalidPayload, 'user-1')).rejects.toThrow();
  });

  it('returns zero counts for an empty payload', async () => {
    const result = await importOrchestrationConfig(minPayload, 'user-1');

    expect(result.agents).toEqual({ created: 0, updated: 0 });
    expect(result.capabilities).toEqual({ created: 0, updated: 0 });
    expect(result.workflows).toEqual({ created: 0, updated: 0 });
    expect(result.webhooks).toEqual({ created: 0, skipped: 0 });
    expect(result.settingsUpdated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('creates a new agent when no existing record found → agents.created = 1', async () => {
    mockTx.aiAgent.findUnique.mockResolvedValue(null);
    mockTx.aiAgent.create.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, agents: [makeAgent()] } };
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiAgent.create).toHaveBeenCalledOnce();
    expect(mockTx.aiAgent.update).not.toHaveBeenCalled();
    expect(result.agents.created).toBe(1);
    expect(result.agents.updated).toBe(0);
  });

  it('updates existing agent when record already exists → agents.updated = 1', async () => {
    mockTx.aiAgent.findUnique.mockResolvedValue({ id: 'existing-id', slug: 'support-bot' });
    mockTx.aiAgent.update.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, agents: [makeAgent()] } };
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiAgent.update).toHaveBeenCalledOnce();
    expect(mockTx.aiAgent.create).not.toHaveBeenCalled();
    expect(result.agents.updated).toBe(1);
    expect(result.agents.created).toBe(0);
  });

  it('creates a new capability → capabilities.created = 1', async () => {
    mockTx.aiCapability.findUnique.mockResolvedValue(null);
    mockTx.aiCapability.create.mockResolvedValue({});

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, capabilities: [makeCapability()] },
    };
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiCapability.create).toHaveBeenCalledOnce();
    expect(result.capabilities.created).toBe(1);
  });

  it('creates a new workflow → workflows.created = 1', async () => {
    mockTx.aiWorkflow.findUnique.mockResolvedValue(null);
    mockTx.aiWorkflow.create.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflow.update.mockResolvedValue({ id: 'wf-1' });
    mockTx.aiWorkflowVersion.create.mockResolvedValue({ id: 'wfv-1', version: 1 });

    const payload = { ...minPayload, data: { ...minPayload.data, workflows: [makeWorkflow()] } };
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiWorkflow.create).toHaveBeenCalledOnce();
    expect(mockTx.aiWorkflowVersion.create).toHaveBeenCalledOnce();
    expect(result.workflows.created).toBe(1);
  });

  it('creates a new webhook when no existing record found → webhooks.created = 1', async () => {
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
    mockTx.aiWebhookSubscription.create.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, webhooks: [makeWebhook()] } };
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiWebhookSubscription.create).toHaveBeenCalledOnce();
    expect(result.webhooks.created).toBe(1);
    expect(result.webhooks.skipped).toBe(0);
  });

  it('skips existing webhook by URL → webhooks.skipped = 1', async () => {
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue({
      id: 'wh-1',
      url: 'https://example.com/hook',
    });

    const payload = { ...minPayload, data: { ...minPayload.data, webhooks: [makeWebhook()] } };
    const result = await importOrchestrationConfig(payload, 'user-1');

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
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiOrchestrationSettings.upsert).toHaveBeenCalledOnce();
    // test-review:accept tobe_true — boolean field `settingsUpdated` on ImportResult; structural assertion on import outcome
    expect(result.settingsUpdated).toBe(true);
  });

  it('sets settingsUpdated: false when settings is null', async () => {
    const payload = { ...minPayload, data: { ...minPayload.data, settings: null } };
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiOrchestrationSettings.upsert).not.toHaveBeenCalled();
    expect(result.settingsUpdated).toBe(false);
  });

  it('adds a warning to warnings array when a webhook is imported without a secret', async () => {
    mockTx.aiWebhookSubscription.findFirst.mockResolvedValue(null);
    mockTx.aiWebhookSubscription.create.mockResolvedValue({});

    // Webhook payload without secret (as exported — secret is never in export)
    const webhook = makeWebhook();
    const payload = { ...minPayload, data: { ...minPayload.data, webhooks: [webhook] } };
    const result = await importOrchestrationConfig(payload, 'user-1');

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
    await importOrchestrationConfig(payload, 'user-1');

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
    const result = await importOrchestrationConfig(payload, 'user-1');

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
    await importOrchestrationConfig(payload, 'user-1');

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
    const result = await importOrchestrationConfig(payload, 'user-1');

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
});

// ─── Knowledge tag import ────────────────────────────────────────────────────

describe('importOrchestrationConfig — knowledgeTags', () => {
  beforeEach(() => {
    mockTx.aiAgent.findUnique.mockReset();
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
    const result = await importOrchestrationConfig(payload, 'user-1');

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
    const result = await importOrchestrationConfig(payload, 'user-1');

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
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(result.knowledgeTags.created).toBe(1);
    expect(result.knowledgeTags.updated).toBe(1);
  });
});

// ─── System agent skip ────────────────────────────────────────────────────────

describe('importOrchestrationConfig — system agent protection', () => {
  beforeEach(() => {
    mockTx.aiAgent.findUnique.mockReset();
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
    mockTx.aiAgent.findUnique.mockResolvedValue({
      id: 'sys-1',
      slug: 'system-bot',
      isSystem: true,
    });

    const payload = {
      ...minPayload,
      data: { ...minPayload.data, agents: [makeAgent({ slug: 'system-bot' })] },
    };
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiAgent.update).not.toHaveBeenCalled();
    expect(mockTx.aiAgent.create).not.toHaveBeenCalled();
    expect(result.agents.updated).toBe(0);
    expect(result.agents.created).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('system-bot')])
    );
    expect(result.warnings[0]).toMatch(/system agents cannot be overwritten/i);
  });
});

// ─── Grant resolution ─────────────────────────────────────────────────────────

describe('importOrchestrationConfig — knowledge grants', () => {
  beforeEach(() => {
    mockTx.aiAgent.findUnique.mockReset();
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
    mockTx.aiAgent.findUnique
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
    await importOrchestrationConfig(payload, 'user-1');

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
    mockTx.aiAgent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-2' });
    mockTx.aiAgent.create.mockResolvedValue({ id: 'agent-2' });
    mockTx.aiKnowledgeDocument.findMany.mockResolvedValue([]);

    const payload = {
      ...minPayload,
      data: {
        ...minPayload.data,
        agents: [makeAgent({ grantedTagSlugs: ['missing-tag'], grantedDocumentHashes: [] })],
      },
    };
    const result = await importOrchestrationConfig(payload, 'user-1');

    // No createMany for tags because resolution failed
    expect(mockTx.aiAgentKnowledgeTag.createMany).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/missing knowledge-tag slug 'missing-tag'/)])
    );
  });

  it('resolves document grants by fileHash and calls createMany', async () => {
    mockTx.aiAgent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-3' });
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
    await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiAgentKnowledgeDocument.deleteMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-3' },
    });
    expect(mockTx.aiAgentKnowledgeDocument.createMany).toHaveBeenCalledWith({
      data: [{ agentId: 'agent-3', documentId: 'doc-1' }],
      skipDuplicates: true,
    });
  });

  it('emits a warning for missing document hashes and skips the missing doc grant', async () => {
    mockTx.aiAgent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-4' });
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
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiAgentKnowledgeDocument.createMany).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/missing knowledge document.*deadbeef1234/i)])
    );
  });

  it('does not call createMany for tags when there are no resolved tag ids', async () => {
    mockTx.aiAgent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-5' });
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
    await importOrchestrationConfig(payload, 'user-1');

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
    mockTx.aiAgent.findUnique.mockReset();
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
    mockTx.aiAgent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'agent-v1' });
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
    const result = await importOrchestrationConfig(v1Payload, 'user-1');

    // The importer slugifies 'Billing Support' → 'billing-support' and upserts it
    expect(mockTx.knowledgeTag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'billing-support' } })
    );
    // Tag created counted
    expect(result.knowledgeTags.created).toBe(1);
  });

  it('skips blank knowledgeCategories entries when inferring v1 tags', async () => {
    mockTx.aiAgent.findUnique
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
    await importOrchestrationConfig(v1Payload, 'user-1');

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
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiCapability.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'web-search' } })
    );
    expect(mockTx.aiCapability.create).not.toHaveBeenCalled();
    expect(result.capabilities.updated).toBe(1);
    expect(result.capabilities.created).toBe(0);
  });
});
