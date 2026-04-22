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
  aiWebhookSubscription: { findFirst: vi.fn(), create: vi.fn() },
  aiOrchestrationSettings: { upsert: vi.fn() },
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
    workflowDefinition: { steps: [] },
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
    webhookRetentionDays: null,
    costLogRetentionDays: null,
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
    mockTx.aiWebhookSubscription.findFirst.mockReset();
    mockTx.aiWebhookSubscription.create.mockReset();
    mockTx.aiOrchestrationSettings.upsert.mockReset();
  });

  it('throws ZodError when schema is invalid (wrong schemaVersion)', async () => {
    const invalidPayload = { ...minPayload, schemaVersion: 2 };

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
    mockTx.aiWorkflow.create.mockResolvedValue({});

    const payload = { ...minPayload, data: { ...minPayload.data, workflows: [makeWorkflow()] } };
    const result = await importOrchestrationConfig(payload, 'user-1');

    expect(mockTx.aiWorkflow.create).toHaveBeenCalledOnce();
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
});
