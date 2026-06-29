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
    knowledgeTag: { findMany: (...a: unknown[]) => mockFindMany(...a) },
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
  knowledgeAccessMode: 'full',
  knowledgeRetrievalMode: 'keywords',
  topicBoundaries: [],
  brandVoiceInstructions: null,
  widgetConfig: null,
  // Discriminator + inheritance + attachment + runtime-prompt fields — these
  // were silently dropped from config backups before; distinctive values here
  // assert they now round-trip rather than reverting to defaults.
  kind: 'judge',
  reasoningEffort: 'high',
  persona: 'A terse support persona',
  guardrails: 'Never disclose internal pricing',
  personaMode: 'append',
  voiceMode: 'append',
  guardrailsMode: 'append',
  enableVoiceInput: true,
  enableImageInput: true,
  enableDocumentInput: true,
  runtimePromptManaged: true,
  runtimePromptNote: 'Prompt assembled in app code',
  // Include shape from the new exporter query — no grants for the default fixture.
  grantedTags: [],
  grantedDocuments: [],
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
  // Definition is now sourced from the published version relation, not a
  // top-level column. The exporter flattens this back to `workflowDefinition`
  // in the wire payload.
  publishedVersion: { snapshot: { steps: [] } },
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

  it('returns payload with schemaVersion: 2', async () => {
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.schemaVersion).toBe(2);
  });

  it('returns payload with exportedAt as an ISO string', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
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
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.agents).toHaveLength(1);
    const exported = payload.data.agents[0];
    expect(exported.name).toBe('Support Bot');
    expect(exported.slug).toBe('support-bot');
    // Fields that a config backup previously dropped — assert they survive.
    expect(exported.kind).toBe('judge');
    expect(exported.reasoningEffort).toBe('high');
    expect(exported.persona).toBe('A terse support persona');
    expect(exported.guardrails).toBe('Never disclose internal pricing');
    expect(exported.personaMode).toBe('append');
    expect(exported.voiceMode).toBe('append');
    expect(exported.guardrailsMode).toBe('append');
    expect(exported.enableVoiceInput).toBe(true);
    expect(exported.enableImageInput).toBe(true);
    expect(exported.enableDocumentInput).toBe(true);
    expect(exported.runtimePromptManaged).toBe(true);
    expect(exported.runtimePromptNote).toBe('Prompt assembled in app code');
  });

  it('queries agents with where: { isSystem: false }', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
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
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
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
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
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
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
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
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(settingsRow);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.agents).toHaveLength(1);
    expect(payload.data.capabilities).toHaveLength(1);
    expect(payload.data.workflows).toHaveLength(1);
    expect(payload.data.webhooks).toHaveLength(1);
    expect(payload.data.settings).not.toBeNull();
  });

  it('skips workflows that have no published version (no exportable snapshot)', async () => {
    // Edge case: a workflow row with publishedVersion=null can't be exported
    // because the snapshot lives there in the new model. The exporter's
    // flatMap drops such rows rather than emitting an entry with no
    // workflowDefinition.
    const unpublishedRow = { ...workflowRow, slug: 'never-published', publishedVersion: null };
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([workflowRow, unpublishedRow]) // workflows: one with, one without
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.workflows).toHaveLength(1);
    expect(payload.data.workflows[0].slug).toBe('onboarding-flow');
  });

  it('exports knowledgeTags when present in the DB', async () => {
    const tagRow = { slug: 'support', name: 'Support', description: 'support topics' };
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([tagRow]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.knowledgeTags).toHaveLength(1);
    expect(payload.data.knowledgeTags[0].slug).toBe('support');
    expect(payload.data.knowledgeTags[0].name).toBe('Support');
  });

  it('emits knowledgeAccessMode as "restricted" when the DB row has that value', async () => {
    // This exercises the ternary on line ~142: knowledgeAccessMode === 'restricted'
    const restrictedAgentRow = {
      ...agentRow,
      knowledgeAccessMode: 'restricted',
    };
    mockFindMany
      .mockResolvedValueOnce([restrictedAgentRow]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.agents[0].knowledgeAccessMode).toBe('restricted');
  });

  it('emits knowledgeAccessMode as "full" for any non-restricted value', async () => {
    // Any value that is not 'restricted' coerces to 'full' (the else branch)
    const fullAgentRow = {
      ...agentRow,
      knowledgeAccessMode: 'full',
    };
    mockFindMany
      .mockResolvedValueOnce([fullAgentRow]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.agents[0].knowledgeAccessMode).toBe('full');
  });

  it('flattens grantedTags into grantedTagSlugs array', async () => {
    const agentWithGrants = {
      ...agentRow,
      grantedTags: [{ tag: { slug: 'billing' } }, { tag: { slug: 'support' } }],
      grantedDocuments: [],
    };
    mockFindMany
      .mockResolvedValueOnce([agentWithGrants]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.agents[0].grantedTagSlugs).toEqual(['billing', 'support']);
  });

  it('flattens grantedDocuments into grantedDocumentHashes array', async () => {
    const agentWithDocs = {
      ...agentRow,
      grantedTags: [],
      grantedDocuments: [
        { document: { fileHash: 'abc123' } },
        { document: { fileHash: 'def456' } },
      ],
    };
    mockFindMany
      .mockResolvedValueOnce([agentWithDocs]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.agents[0].grantedDocumentHashes).toEqual(['abc123', 'def456']);
  });

  it('always emits empty knowledgeCategories array (legacy field kept on wire)', async () => {
    // knowledgeCategories was dropped from the DB in Phase 6 but the backup
    // schema keeps the field on the wire. The exporter always emits [] for it.
    mockFindMany
      .mockResolvedValueOnce([agentRow]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig();

    expect(payload.data.agents[0].knowledgeCategories).toEqual([]);
  });

  it('queries capabilities with where: { isSystem: false }', async () => {
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    await exportOrchestrationConfig();

    // Second findMany call is for capabilities
    const capCall = mockFindMany.mock.calls[1][0] as { where?: { isSystem?: boolean } };
    expect(capCall?.where?.isSystem).toBe(false);
  });
});
