/**
 * Tests for `lib/orchestration/backup/schema.ts`
 *
 * Pure Zod validation — no mocks required.
 *
 * @see lib/orchestration/backup/schema.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { backupSchema } from '@/lib/orchestration/backup/schema';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeValidAgent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Support Bot',
    slug: 'support-bot',
    description: 'Handles support queries',
    systemInstructions: 'You are a helpful assistant.',
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

function makeValidWebhook(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com/webhook',
    events: ['workflow.completed'],
    description: null,
    isActive: true,
    ...overrides,
  };
}

function makeValidSettings() {
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
    auditLogRetentionDays: null,
    maxConversationsPerUser: null,
    maxMessagesPerConversation: null,
    escalationConfig: null,
  };
}

function makeValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      agents: [],
      capabilities: [],
      workflows: [],
      webhooks: [],
      settings: null,
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('backupSchema', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('accepts a valid complete payload', () => {
    const payload = makeValidPayload({
      data: {
        agents: [makeValidAgent()],
        capabilities: [],
        workflows: [],
        webhooks: [makeValidWebhook()],
        settings: makeValidSettings(),
      },
    });

    expect(() => backupSchema.parse(payload)).not.toThrow();
  });

  it('rejects wrong schemaVersion (e.g. 2)', () => {
    const payload = makeValidPayload({ schemaVersion: 2 });

    expect(() => backupSchema.parse(payload)).toThrow();
  });

  it('rejects missing schemaVersion', () => {
    const { schemaVersion: _, ...payload } = makeValidPayload() as Record<string, unknown>;

    expect(() => backupSchema.parse(payload)).toThrow();
  });

  it('rejects missing data', () => {
    const { data: _, ...payload } = makeValidPayload() as Record<string, unknown>;

    expect(() => backupSchema.parse(payload)).toThrow();
  });

  it('accepts data.agents with a valid agent', () => {
    const payload = makeValidPayload({
      data: {
        agents: [makeValidAgent()],
        capabilities: [],
        workflows: [],
        webhooks: [],
        settings: null,
      },
    });

    const parsed = backupSchema.parse(payload);
    expect(parsed.data.agents).toHaveLength(1);
    expect(parsed.data.agents[0].name).toBe('Support Bot');
  });

  it('rejects agent missing required field name', () => {
    const agentWithoutName = makeValidAgent();
    delete (agentWithoutName as Record<string, unknown>).name;

    const payload = makeValidPayload({
      data: {
        agents: [agentWithoutName],
        capabilities: [],
        workflows: [],
        webhooks: [],
        settings: null,
      },
    });

    expect(() => backupSchema.parse(payload)).toThrow();
  });

  it('accepts data.settings: null', () => {
    const payload = makeValidPayload({
      data: { agents: [], capabilities: [], workflows: [], webhooks: [], settings: null },
    });

    const parsed = backupSchema.parse(payload);
    expect(parsed.data.settings).toBeNull();
  });

  it('accepts data.webhooks with optional secret field', () => {
    const webhookWithSecret = makeValidWebhook({ secret: 'whsec_abc123' });
    const payload = makeValidPayload({
      data: {
        agents: [],
        capabilities: [],
        workflows: [],
        webhooks: [webhookWithSecret],
        settings: null,
      },
    });

    const parsed = backupSchema.parse(payload);
    expect(parsed.data.webhooks[0].secret).toBe('whsec_abc123');
  });

  it('accepts data.webhooks without secret field', () => {
    const payload = makeValidPayload({
      data: {
        agents: [],
        capabilities: [],
        workflows: [],
        webhooks: [makeValidWebhook()],
        settings: null,
      },
    });

    const parsed = backupSchema.parse(payload);
    expect(parsed.data.webhooks[0].secret).toBeUndefined();
  });

  it('exportedAt must be a string', () => {
    const payload = makeValidPayload({ exportedAt: 12345 });

    expect(() => backupSchema.parse(payload)).toThrow();
  });

  it('exportedAt accepts any string value', () => {
    const payload = makeValidPayload({ exportedAt: '2026-01-01T00:00:00Z' });

    const parsed = backupSchema.parse(payload);
    expect(typeof parsed.exportedAt).toBe('string');
  });
});
