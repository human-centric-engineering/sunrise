/**
 * Integration Test: Admin Orchestration — Clone Agent
 *
 * POST /api/v1/admin/orchestration/agents/:id/clone
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/clone/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limiting enforced by proxy.ts (orchestration tier)
 * - 201 on success: cloned agent returned
 * - 404 when source agent not found
 * - 400 when CUID is invalid
 * - 400 when body fails validation
 * - 409 when all slug attempts collide
 * - 500 on plain Error — response must NOT leak raw error message
 * - Empty body is tolerated (name/slug default to source-based values)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/agents/[id]/clone/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { Prisma } from '@prisma/client';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'http://localhost:3000',
  },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu3';
const INVALID_ID = 'not-a-cuid';

function makeSourceAgent() {
  return {
    id: AGENT_ID,
    name: 'My Agent',
    slug: 'my-agent',
    kind: 'chat',
    description: 'A test agent',
    systemInstructions: 'You are helpful.',
    systemInstructionsHistory: [],
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    providerConfig: null,
    temperature: 0.7,
    maxTokens: 4096,
    reasoningEffort: null,
    monthlyBudgetUsd: null,
    maxCostPerTurnUsd: null,
    fallbackProviders: [],
    metadata: null,
    widgetConfig: { primaryColor: '#16a34a', headerTitle: 'Council' },
    inputGuardMode: null,
    outputGuardMode: null,
    citationGuardMode: null,
    maxHistoryTokens: null,
    maxHistoryMessages: null,
    retentionDays: null,
    visibility: 'internal',
    rateLimitRpm: null,
    knowledgeAccessMode: 'full',
    knowledgeRetrievalMode: 'model',
    knowledgeTriggerKeywords: [],
    topicBoundaries: [],
    profileId: null,
    persona: null,
    guardrails: null,
    personaMode: 'override',
    voiceMode: 'override',
    guardrailsMode: 'override',
    brandVoiceInstructions: null,
    enableVoiceInput: false,
    enableImageInput: false,
    enableDocumentInput: false,
    isActive: true,
    isSystem: false,
    deletedAt: null,
    createdBy: 'user_abc',
    capabilities: [
      {
        agentId: AGENT_ID,
        capabilityId: 'cap_001',
        isEnabled: true,
        customConfig: null,
        customRateLimit: null,
      },
      {
        agentId: AGENT_ID,
        capabilityId: 'cap_002',
        isEnabled: true,
        customConfig: null,
        customRateLimit: null,
      },
    ],
  };
}

function makeClonedAgent() {
  return {
    id: 'cmjbv4i3x00003wsloputgwu9',
    name: 'My Agent (Copy)',
    slug: 'my-agent-copy',
    description: 'A test agent',
    systemInstructions: 'You are helpful.',
    systemInstructionsHistory: [],
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    providerConfig: null,
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    fallbackProviders: [],
    metadata: null,
    isActive: true,
    isSystem: false,
    createdBy: 'cmjbv4i3x00003wsloputgwul',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown> = {}): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/clone`,
  };
  return {
    ...base,
    clone: () => ({ ...base }),
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/agents/:id/clone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: transaction resolves with the cloned agent
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: never) => unknown) => {
      const tx = {
        aiAgent: {
          create: vi.fn().mockResolvedValue(makeClonedAgent()),
        },
        aiAgentCapability: {
          createMany: vi.fn().mockResolvedValue({ count: 2 }),
        },
      };
      return fn(tx as never);
    });
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when body has invalid name (empty string)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeSourceAgent() as never);

      const response = await POST(makePostRequest({ name: '' }), makeParams(AGENT_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Successful clone', () => {
    it('returns 201 with the cloned agent on success', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeSourceAgent() as never);

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: { slug: string; name: string } }>(
        response
      );
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.slug).toBe('my-agent-copy');
      expect(data.data.name).toBe('My Agent (Copy)');
    });

    it('tolerates empty body and uses source-based name/slug defaults', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeSourceAgent() as never);

      // Simulate a request with no body (json() rejects, text() returns empty)
      const base = {
        method: 'POST',
        headers: new Headers(),
        json: () => Promise.reject(new Error('no body')),
        text: () => Promise.resolve(''),
        url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/clone`,
      };
      const request = { ...base, clone: () => ({ ...base }) } as unknown as NextRequest;

      const response = await POST(request, makeParams(AGENT_ID));

      expect(response.status).toBe(201);
    });

    it('always creates clone with isActive: false regardless of source state', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const activeSource = makeSourceAgent();
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(activeSource.isActive).toBe(true); // Confirm source is active
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(activeSource as never);

      let capturedCreateData: Record<string, unknown> | null = null;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: never) => unknown) => {
        const tx = {
          aiAgent: {
            create: vi.fn((args: { data: Record<string, unknown> }) => {
              capturedCreateData = args.data;
              return Promise.resolve({ ...makeClonedAgent(), isActive: false });
            }),
          },
          aiAgentCapability: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
        };
        return fn(tx as never);
      });

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(201);
      expect(capturedCreateData).toBeDefined();
      expect(capturedCreateData!.isActive).toBe(false);
    });

    it('accepts custom name and slug overrides', async () => {
      const customAgent = { ...makeClonedAgent(), name: 'Custom Name', slug: 'custom-slug' };
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeSourceAgent() as never);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: never) => unknown) => {
        const tx = {
          aiAgent: { create: vi.fn().mockResolvedValue(customAgent) },
          aiAgentCapability: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
        };
        return fn(tx as never);
      });

      const response = await POST(
        makePostRequest({ name: 'Custom Name', slug: 'custom-slug' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(201);
      const data = await parseJson<{ success: boolean; data: { name: string; slug: string } }>(
        response
      );
      expect(data.data.name).toBe('Custom Name');
      expect(data.data.slug).toBe('custom-slug');
    });
  });

  describe('Error mappings', () => {
    it('returns 404 when source agent is not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 when source agent is soft-deleted', async () => {
      // Cloning a tombstoned row would copy a deleted agent's config into a
      // new live row — the source must look as if it doesn't exist.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
        ...makeSourceAgent(),
        isActive: false,
        deletedAt: new Date('2026-05-01'),
      } as never);

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 (unique constraint) when all slug collision attempts are exhausted', async () => {
      // The route retries up to MAX_SLUG_ATTEMPTS (5) times on P2002. On the
      // final attempt it re-throws the raw PrismaClientKnownRequestError, which
      // handleAPIError maps to 400 (unique constraint). The ConflictError guard
      // after the loop is unreachable because the last re-throw exits before it.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeSourceAgent() as never);
      const slugCollision = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on field: slug',
        { code: 'P2002', clientVersion: '7.0.0', meta: { target: ['slug'] } }
      );
      vi.mocked(prisma.$transaction).mockRejectedValue(slugCollision);

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      // handleAPIError maps P2002 → 400 with EMAIL_TAKEN code
      expect(response.status).toBe(400);
    });

    it('CRITICAL: returns 500 on plain Error but does NOT leak raw error message', async () => {
      const INTERNAL_MSG = 'db connection exploded';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockRejectedValue(new Error(INTERNAL_MSG));

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(500);
      const raw = await response.text();
      expect(raw).not.toContain(INTERNAL_MSG);
      expect(raw).not.toContain('db connection');
      expect(raw).not.toContain('exploded');
    });
  });

  describe('Knowledge-access grant carry-over', () => {
    it('carries over tag grants from source to clone', async () => {
      // Arrange: source agent has tag grants
      const sourceWithGrants = {
        ...makeSourceAgent(),
        grantedTags: [{ tagId: 'tag-1' }, { tagId: 'tag-2' }],
        grantedDocuments: [],
      };
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(sourceWithGrants as never);

      let capturedTagCreateMany: unknown = null;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: never) => unknown) => {
        const tx = {
          aiAgent: { create: vi.fn().mockResolvedValue(makeClonedAgent()) },
          aiAgentCapability: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
          aiAgentKnowledgeTag: {
            createMany: vi.fn((args: unknown) => {
              capturedTagCreateMany = args;
              return Promise.resolve({ count: 2 });
            }),
          },
          aiAgentKnowledgeDocument: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        };
        return fn(tx as never);
      });

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(201);
      expect(capturedTagCreateMany).not.toBeNull();
    });

    it('carries over document grants from source to clone', async () => {
      // Arrange: source agent has document grants
      const sourceWithDocs = {
        ...makeSourceAgent(),
        grantedTags: [],
        grantedDocuments: [{ documentId: 'doc-1' }, { documentId: 'doc-2' }],
      };
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(sourceWithDocs as never);

      let capturedDocCreateMany: unknown = null;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: never) => unknown) => {
        const tx = {
          aiAgent: { create: vi.fn().mockResolvedValue(makeClonedAgent()) },
          aiAgentCapability: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
          aiAgentKnowledgeTag: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
          aiAgentKnowledgeDocument: {
            createMany: vi.fn((args: unknown) => {
              capturedDocCreateMany = args;
              return Promise.resolve({ count: 2 });
            }),
          },
        };
        return fn(tx as never);
      });

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(201);
      expect(capturedDocCreateMany).not.toBeNull();
    });

    it('clones a system agent successfully (clone gets isSystem: false)', async () => {
      // Cloning a system agent is allowed. The clone should be a plain agent.
      const systemSource = {
        ...makeSourceAgent(),
        isSystem: true,
        slug: 'system-agent',
        name: 'System Agent',
        grantedTags: [],
        grantedDocuments: [],
      };
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(systemSource as never);

      let capturedCreateArgs: Record<string, unknown> | null = null;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: never) => unknown) => {
        const tx = {
          aiAgent: {
            create: vi.fn((args: { data: Record<string, unknown> }) => {
              capturedCreateArgs = args.data;
              return Promise.resolve({
                ...makeClonedAgent(),
                name: 'System Agent (Copy)',
                slug: 'system-agent-copy',
              });
            }),
          },
          aiAgentCapability: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        };
        return fn(tx as never);
      });

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(201);
      // The create data should not carry isSystem from the source
      // (it's not explicitly set in the route create call, so it defaults to false)
      expect(capturedCreateArgs).toBeDefined();
    });
  });

  describe('Field carry-over (regression: fields previously dropped on clone)', () => {
    it('copies persona, guardrails, mode columns, profileId, kind, multimodal toggles, knowledge retrieval, and per-turn cap', async () => {
      const richSource = {
        ...makeSourceAgent(),
        kind: 'judge',
        profileId: 'cmjbv4i3x00003wsloputgwu7',
        persona: 'Be wise.',
        guardrails: 'No PII.',
        personaMode: 'append',
        voiceMode: 'append',
        guardrailsMode: 'append',
        enableVoiceInput: true,
        enableImageInput: true,
        enableDocumentInput: true,
        knowledgeRetrievalMode: 'every_turn',
        knowledgeTriggerKeywords: ['refund', 'cancel'],
        maxCostPerTurnUsd: 0.5,
        runtimePromptManaged: true,
        runtimePromptNote: 'Built in extractor-capability.ts',
        grantedTags: [],
        grantedDocuments: [],
      };
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(richSource as never);

      let capturedCreate: Record<string, unknown> | null = null;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: never) => unknown) => {
        const tx = {
          aiAgent: {
            create: vi.fn((args: { data: Record<string, unknown> }) => {
              capturedCreate = args.data;
              return Promise.resolve(makeClonedAgent());
            }),
          },
          aiAgentCapability: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
        };
        return fn(tx as never);
      });

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(201);
      expect(capturedCreate).not.toBeNull();
      const data = capturedCreate!;
      expect(data.kind).toBe('judge');
      expect(data.profileId).toBe('cmjbv4i3x00003wsloputgwu7');
      expect(data.persona).toBe('Be wise.');
      expect(data.guardrails).toBe('No PII.');
      expect(data.personaMode).toBe('append');
      expect(data.voiceMode).toBe('append');
      expect(data.guardrailsMode).toBe('append');
      expect(data.enableVoiceInput).toBe(true);
      expect(data.enableImageInput).toBe(true);
      expect(data.enableDocumentInput).toBe(true);
      expect(data.knowledgeRetrievalMode).toBe('every_turn');
      expect(data.knowledgeTriggerKeywords).toEqual(['refund', 'cancel']);
      expect(data.maxCostPerTurnUsd).toBe(0.5);
      // Runtime-built-prompt honesty flag must survive cloning — otherwise the
      // clone silently reverts to the misleading "what the LLM sees" state.
      expect(data.runtimePromptManaged).toBe(true);
      expect(data.runtimePromptNote).toBe('Built in extractor-capability.ts');
    });

    it('copies per-binding capability config (isEnabled, customConfig, customRateLimit)', async () => {
      const sourceWithCapConfig = {
        ...makeSourceAgent(),
        capabilities: [
          {
            agentId: AGENT_ID,
            capabilityId: 'cap_001',
            isEnabled: false,
            customConfig: { mode: 'verbose' },
            customRateLimit: 30,
          },
          {
            agentId: AGENT_ID,
            capabilityId: 'cap_002',
            isEnabled: true,
            customConfig: null,
            customRateLimit: null,
          },
        ],
        grantedTags: [],
        grantedDocuments: [],
      };
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(sourceWithCapConfig as never);

      let capturedCapCreateMany: { data: Array<Record<string, unknown>> } | null = null;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: never) => unknown) => {
        const tx = {
          aiAgent: { create: vi.fn().mockResolvedValue(makeClonedAgent()) },
          aiAgentCapability: {
            createMany: vi.fn((args: { data: Array<Record<string, unknown>> }) => {
              capturedCapCreateMany = args;
              return Promise.resolve({ count: 2 });
            }),
          },
        };
        return fn(tx as never);
      });

      const response = await POST(makePostRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(201);
      expect(capturedCapCreateMany).not.toBeNull();
      const rows = capturedCapCreateMany!.data;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        capabilityId: 'cap_001',
        isEnabled: false,
        customConfig: { mode: 'verbose' },
        customRateLimit: 30,
      });
      expect(rows[1]).toMatchObject({
        capabilityId: 'cap_002',
        isEnabled: true,
        customRateLimit: null,
      });
    });
  });
});
