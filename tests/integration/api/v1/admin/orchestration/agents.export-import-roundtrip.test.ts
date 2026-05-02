/**
 * Integration Test: Agent Export → Import Round-Trip
 *
 * Verifies that an exported agent can be re-imported with all its data
 * intact: name, slug, systemInstructions, model, and capabilities.
 *
 * @see app/api/v1/admin/orchestration/agents/export/route.ts
 * @see app/api/v1/admin/orchestration/agents/import/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as ExportPOST } from '@/app/api/v1/admin/orchestration/agents/export/route';
import { POST as ImportPOST } from '@/app/api/v1/admin/orchestration/agents/import/route';
import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

/**
 * Shared mock Prisma client. The $transaction mock executes the callback
 * with a transactional client that records create/update calls so we can
 * verify the import wrote the correct data.
 */
vi.mock('@/lib/db/client', () => {
  const txMock = {
    aiAgent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    aiAgentCapability: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };

  return {
    prisma: {
      aiAgent: { findMany: vi.fn() },
      aiCapability: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock)),
      _txMock: txMock,
    },
  };
});

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/capabilities', () => ({
  capabilityDispatcher: { clearCache: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const CAPABILITY_SLUG = 'search_knowledge_base';
const CAPABILITY_ID = 'cap-search-1';

function makeDbAgent() {
  return {
    id: AGENT_ID,
    name: 'Research Assistant',
    slug: 'research-assistant',
    description: 'Helps with research tasks',
    systemInstructions: 'You are a research assistant. Always cite sources.',
    systemInstructionsHistory: [],
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    providerConfig: { timeout: 5000 },
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: 50,
    metadata: null,
    isActive: true,
    fallbackProviders: ['openai'],
    rateLimitRpm: 30,
    inputGuardMode: 'block',
    outputGuardMode: 'warn_and_continue',
    citationGuardMode: 'log_only',
    maxHistoryTokens: 8000,
    retentionDays: 60,
    visibility: 'invite_only',
    knowledgeCategories: ['finance', 'legal'],
    topicBoundaries: ['politics'],
    brandVoiceInstructions: 'Be formal and concise.',
    createdBy: 'admin-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    capabilities: [
      {
        id: 'link-1',
        agentId: AGENT_ID,
        capabilityId: CAPABILITY_ID,
        isEnabled: true,
        customConfig: null,
        customRateLimit: 10,
        capability: { slug: CAPABILITY_SLUG },
      },
    ],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeExportRequest(agentIds: string[]): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve({ agentIds }),
    url: 'http://localhost:3000/api/v1/admin/orchestration/agents/export',
  } as unknown as NextRequest;
}

function makeImportRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/agents/import',
  } as unknown as NextRequest;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Agent Export → Import Round-Trip', () => {
  const txMock = (
    prisma as unknown as { _txMock: Record<string, Record<string, ReturnType<typeof vi.fn>>> }
  )._txMock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // tx.aiAgent.findUnique returns null so import creates a new agent
    txMock.aiAgent.findUnique.mockResolvedValue(null);
    txMock.aiAgent.create.mockResolvedValue({ id: 'new-agent-id', slug: 'research-assistant' });
    txMock.aiAgentCapability.createMany.mockResolvedValue({ count: 1 });
  });

  it('re-imported agent matches the original (name, slug, instructions, model, capabilities)', async () => {
    // Step 1: Export an agent with a capability
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([makeDbAgent()] as never);

    const exportResponse = await ExportPOST(makeExportRequest([AGENT_ID]));
    expect(exportResponse.status).toBe(200);

    const exportData = JSON.parse(await exportResponse.text()) as {
      success: boolean;
      data: {
        version: string;
        exportedAt: string;
        agents: Array<{
          name: string;
          slug: string;
          systemInstructions: string;
          model: string;
          capabilities: Array<{ slug: string; isEnabled: boolean }>;
        }>;
      };
    };
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(exportData.success).toBe(true);
    const bundle = exportData.data;

    // Step 2: Import the bundle into a fresh environment
    // Resolve the capability slug to an id
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([
      { id: CAPABILITY_ID, slug: CAPABILITY_SLUG },
    ] as never);

    const importResponse = await ImportPOST(makeImportRequest({ bundle }));
    expect(importResponse.status).toBe(200);

    const importData = JSON.parse(await importResponse.text()) as {
      success: boolean;
      data: { imported: number; warnings: string[] };
    };
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(importData.success).toBe(true);
    expect(importData.data.imported).toBe(1);
    expect(importData.data.warnings).toHaveLength(0);

    // Step 3: Verify the agent was created with matching data
    expect(txMock.aiAgent.create).toHaveBeenCalledOnce();
    const createCall = txMock.aiAgent.create.mock.calls[0][0] as { data: Record<string, unknown> };
    const created = createCall.data;

    expect(created.name).toBe('Research Assistant');
    expect(created.slug).toBe('research-assistant');
    expect(created.systemInstructions).toBe('You are a research assistant. Always cite sources.');
    expect(created.model).toBe('claude-sonnet-4-6');
    expect(created.provider).toBe('anthropic');
    expect(created.temperature).toBe(0.7);
    expect(created.maxTokens).toBe(4096);
    expect(created.monthlyBudgetUsd).toBe(50);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(created.isActive).toBe(true);

    // Step 3b: Verify expanded fields round-tripped correctly
    expect(created.fallbackProviders).toEqual(['openai']);
    expect(created.rateLimitRpm).toBe(30);
    expect(created.inputGuardMode).toBe('block');
    expect(created.outputGuardMode).toBe('warn_and_continue');
    expect(created.maxHistoryTokens).toBe(8000);
    expect(created.retentionDays).toBe(60);
    expect(created.visibility).toBe('invite_only');
    expect(created.knowledgeCategories).toEqual(['finance', 'legal']);
    expect(created.topicBoundaries).toEqual(['politics']);
    expect(created.brandVoiceInstructions).toBe('Be formal and concise.');

    // Step 4: Verify capabilities were re-attached
    expect(txMock.aiAgentCapability.createMany).toHaveBeenCalledOnce();
    const pivotCall = txMock.aiAgentCapability.createMany.mock.calls[0][0] as {
      data: Array<{ capabilityId: string; isEnabled: boolean; customRateLimit: number | null }>;
    };
    expect(pivotCall.data).toHaveLength(1);
    expect(pivotCall.data[0].capabilityId).toBe(CAPABILITY_ID);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(pivotCall.data[0].isEnabled).toBe(true);
    expect(pivotCall.data[0].customRateLimit).toBe(10);
  });
});
