/**
 * Tests for `lib/orchestration/backup/exporter.ts`
 *
 * Verifies that exportOrchestrationConfig() queries Prisma correctly,
 * assembles the backup payload structure, and excludes secrets.
 *
 * @see lib/orchestration/backup/exporter.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    aiCapability: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    aiWorkflow: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    aiWebhookSubscription: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    aiOrchestrationSettings: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { exportOrchestrationConfig } from '@/lib/orchestration/backup/exporter';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const agentRow = {
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
};

const capabilityRow = {
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
};

const workflowRow = {
  name: 'Onboarding Flow',
  slug: 'onboarding-flow',
  description: 'New user onboarding',
  workflowDefinition: { steps: [] },
  patternsUsed: [],
  isActive: true,
  isTemplate: false,
  metadata: null,
};

// Webhook row as returned by Prisma select (no secret field selected)
const webhookRow = {
  url: 'https://example.com/hook',
  events: ['workflow.completed'],
  description: null,
  isActive: true,
};

const settingsRow = {
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('exportOrchestrationConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns payload with schemaVersion: 1', async () => {
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.schemaVersion).toBe(1);
  });

  it('returns payload with exportedAt as an ISO string', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindUnique.mockResolvedValue(null);

    const before = new Date().toISOString();
    const payload = await exportOrchestrationConfig();
    const after = new Date().toISOString();

    expect(typeof payload.exportedAt).toBe('string');
    // exportedAt should be a valid ISO date between before and after
    expect(payload.exportedAt.localeCompare(before)).toBeGreaterThanOrEqual(0);
    expect(payload.exportedAt.localeCompare(after)).toBeLessThanOrEqual(0);
  });

  it('maps agents array from DB rows', async () => {
    mockFindMany
      .mockResolvedValueOnce([agentRow]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.agents).toHaveLength(1);
    expect(payload.data.agents[0].name).toBe('Support Bot');
    expect(payload.data.agents[0].slug).toBe('support-bot');
  });

  it('queries agents with where: { isSystem: false }', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindUnique.mockResolvedValue(null);

    await exportOrchestrationConfig();

    // First findMany call is for agents
    const firstCall = mockFindMany.mock.calls[0][0] as { where?: { isSystem?: boolean } };
    expect(firstCall?.where?.isSystem).toBe(false);
  });

  it('returns data.settings as null when no settings record exists', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.settings).toBeNull();
  });

  it('includes settings fields when a settings record exists', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindUnique.mockResolvedValue(settingsRow);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.settings).not.toBeNull();
    expect(payload.data.settings?.defaultModels).toEqual({ chat: 'gpt-4o' });
    expect(payload.data.settings?.globalMonthlyBudgetUsd).toBeNull();
  });

  it('webhook entries do not have a secret field (secrets are never exported)', async () => {
    // The Prisma select excludes secret — the row never has it
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([webhookRow]); // webhooks — no secret
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.webhooks).toHaveLength(1);
    expect(payload.data.webhooks[0]).not.toHaveProperty('secret');
    expect(payload.data.webhooks[0].url).toBe('https://example.com/hook');
  });

  it('returns all four data collections in the correct positions', async () => {
    mockFindMany
      .mockResolvedValueOnce([agentRow])
      .mockResolvedValueOnce([capabilityRow])
      .mockResolvedValueOnce([workflowRow])
      .mockResolvedValueOnce([webhookRow]);
    mockFindUnique.mockResolvedValue(settingsRow);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.agents).toHaveLength(1);
    expect(payload.data.capabilities).toHaveLength(1);
    expect(payload.data.workflows).toHaveLength(1);
    expect(payload.data.webhooks).toHaveLength(1);
    expect(payload.data.settings).not.toBeNull();
  });
});
