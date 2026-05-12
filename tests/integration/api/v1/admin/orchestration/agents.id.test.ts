/**
 * Integration Test: Admin Orchestration Single Agent (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/agents/:id
 * PATCH  /api/v1/admin/orchestration/agents/:id
 * DELETE /api/v1/admin/orchestration/agents/:id
 *
 * Critical: PATCH must push old systemInstructions onto history when the value changes.
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PATCH, DELETE } from '@/app/api/v1/admin/orchestration/agents/[id]/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { Prisma } from '@prisma/client';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => {
  const mock = {
    aiAgent: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    aiAgentVersion: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(),
  };
  // $transaction calls the callback with the mock itself as the tx client
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => Promise<unknown>) => fn(mock));
  return { prisma: mock };
});

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const INVALID_ID = 'not-a-cuid';

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    systemInstructions: 'You are a helpful assistant.',
    systemInstructionsHistory: [],
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    providerConfig: null,
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    metadata: null,
    isActive: true,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(method = 'GET', body?: Record<string, unknown>): NextRequest {
  return {
    method,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body ?? {}),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/agents/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful retrieval', () => {
    it('returns agent by id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { id: string } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(AGENT_ID);
    });
  });

  describe('Error cases', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
    });

    it('returns 404 when agent not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(404);
    });
  });
});

describe('PATCH /api/v1/admin/orchestration/agents/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await PATCH(
        makeRequest('PATCH', { name: 'New Name' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await PATCH(
        makeRequest('PATCH', { name: 'New Name' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on PATCH (mutating route)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent({ name: 'Updated' }) as never);

      await PATCH(makeRequest('PATCH', { name: 'Updated' }), makeParams(AGENT_ID));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });

    it('returns 429 when rate limit exceeded on PATCH', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await PATCH(makeRequest('PATCH', { name: 'Updated' }), makeParams(AGENT_ID));

      expect(response.status).toBe(429);
      // Prisma was not touched because the guard short-circuits
      expect(vi.mocked(prisma.aiAgent.findUnique)).not.toHaveBeenCalled();
    });
  });

  describe('Successful update', () => {
    it('updates non-instructions fields without touching history', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const current = makeAgent({ systemInstructions: 'Original instructions.' });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(current as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent({ name: 'Updated' }) as never);

      const response = await PATCH(makeRequest('PATCH', { name: 'Updated' }), makeParams(AGENT_ID));

      expect(response.status).toBe(200);

      // systemInstructionsHistory must NOT appear in the update data when instructions unchanged
      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('systemInstructionsHistory');
      expect(updateCall.data).not.toHaveProperty('systemInstructions');
    });

    it('pushes old instructions onto history when systemInstructions changes', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const current = makeAgent({
        systemInstructions: 'Old instructions.',
        systemInstructionsHistory: [],
      });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(current as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ systemInstructions: 'New instructions.' }) as never
      );

      const response = await PATCH(
        makeRequest('PATCH', { systemInstructions: 'New instructions.' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(200);

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      // The new instructions value should be set
      expect(updateCall.data.systemInstructions).toBe('New instructions.');
      // History should have the OLD instructions pushed in
      const history = updateCall.data.systemInstructionsHistory as Array<{
        instructions: string;
        changedAt: string;
        changedBy: string;
      }>;
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(1);
      expect(history[0].instructions).toBe('Old instructions.');
      expect(history[0].changedBy).toBe(ADMIN_ID);
      expect(history[0].changedAt).toBeDefined();
    });

    it('appends to existing history when systemInstructions changes again', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const existingHistory = [
        {
          instructions: 'Very old instructions.',
          changedAt: '2025-01-01T00:00:00.000Z',
          changedBy: ADMIN_ID,
        },
      ];
      const current = makeAgent({
        systemInstructions: 'Somewhat old instructions.',
        systemInstructionsHistory: existingHistory,
      });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(current as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ systemInstructions: 'Brand new instructions.' }) as never
      );

      await PATCH(
        makeRequest('PATCH', { systemInstructions: 'Brand new instructions.' }),
        makeParams(AGENT_ID)
      );

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      const history = updateCall.data.systemInstructionsHistory as Array<{
        instructions: string;
      }>;
      expect(history).toHaveLength(2);
      expect(history[0].instructions).toBe('Very old instructions.');
      expect(history[1].instructions).toBe('Somewhat old instructions.');
    });

    it('PATCH updates all optional fields in a single payload', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const current = makeAgent();
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(current as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent() as never);

      const fullPayload = {
        name: 'New Name',
        slug: 'new-slug',
        description: 'New description',
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        providerConfig: { foo: 'bar' },
        temperature: 0.5,
        maxTokens: 8192,
        monthlyBudgetUsd: 100,
        metadata: { key: 'value' },
        isActive: false,
        systemInstructions: 'Brand new instructions.',
      };

      await PATCH(makeRequest('PATCH', fullPayload), makeParams(AGENT_ID));

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        name: 'New Name',
        slug: 'new-slug',
        description: 'New description',
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        providerConfig: { foo: 'bar' },
        temperature: 0.5,
        maxTokens: 8192,
        monthlyBudgetUsd: 100,
        metadata: { key: 'value' },
        isActive: false,
        systemInstructions: 'Brand new instructions.',
      });
    });

    it('PATCH persists enableImageInput and enableDocumentInput', async () => {
      // Regression: the route used to validate these via Zod but never
      // copy them onto the update payload, so toggling either one in
      // the admin form silently reset to false on save. The explicit
      // assertion on `data.enable*Input` locks the mapping in place.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const current = makeAgent();
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(current as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent() as never);

      await PATCH(
        makeRequest('PATCH', {
          enableImageInput: true,
          enableDocumentInput: true,
        }),
        makeParams(AGENT_ID)
      );

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      expect(updateCall.data).toMatchObject({
        enableImageInput: true,
        enableDocumentInput: true,
      });
    });

    it('PATCH leaves untouched attachment toggles out of the update', async () => {
      // When the form posts without the toggles in the payload, the
      // route must not zero them — the existing DB row stays as is.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const current = makeAgent();
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(current as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent() as never);

      await PATCH(makeRequest('PATCH', { temperature: 0.3 }), makeParams(AGENT_ID));

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('enableImageInput');
      expect(updateCall.data).not.toHaveProperty('enableDocumentInput');
    });

    it('resets history to [] when stored systemInstructionsHistory is malformed', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const current = makeAgent({
        systemInstructions: 'Old instructions.',
        systemInstructionsHistory: 'not-an-array',
      });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(current as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ systemInstructions: 'New.' }) as never
      );

      await PATCH(makeRequest('PATCH', { systemInstructions: 'New.' }), makeParams(AGENT_ID));

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      const history = updateCall.data.systemInstructionsHistory as Array<{
        instructions: string;
      }>;
      // Malformed history was reset to [] before pushing the old value
      expect(history).toHaveLength(1);
      expect(history[0].instructions).toBe('Old instructions.');
    });

    it('does NOT push to history when systemInstructions value is unchanged', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const sameInstructions = 'You are a helpful assistant.';
      const current = makeAgent({
        systemInstructions: sameInstructions,
        systemInstructionsHistory: [],
      });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(current as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(current as never);

      await PATCH(
        makeRequest('PATCH', { systemInstructions: sameInstructions }),
        makeParams(AGENT_ID)
      );

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('systemInstructionsHistory');
    });
  });

  describe('Error cases', () => {
    it('returns 404 when agent not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

      const response = await PATCH(makeRequest('PATCH', { name: 'x' }), makeParams(AGENT_ID));

      expect(response.status).toBe(404);
    });

    it('returns 400 for P2002 slug conflict on PATCH', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.0.0',
      });
      vi.mocked(prisma.aiAgent.update).mockRejectedValue(p2002);

      const response = await PATCH(
        makeRequest('PATCH', { slug: 'existing-slug' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(400);
    });
  });

  describe('Version snapshot triggers', () => {
    it('creates a version snapshot when a newly-versioned field changes (inputGuardMode)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({ inputGuardMode: null }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ inputGuardMode: 'block' }) as never
      );

      const response = await PATCH(
        makeRequest('PATCH', { inputGuardMode: 'block' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(200);
      expect(prisma.aiAgentVersion.create).toHaveBeenCalledOnce();
      const createCall = vi.mocked(prisma.aiAgentVersion.create).mock.calls[0][0];
      expect(createCall.data.changeSummary).toContain('inputGuardMode changed');
    });

    it('creates a version snapshot when visibility changes', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({ visibility: 'internal' }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ visibility: 'public' }) as never
      );

      const response = await PATCH(
        makeRequest('PATCH', { visibility: 'public' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(200);
      expect(prisma.aiAgentVersion.create).toHaveBeenCalledOnce();
    });

    it('captures expanded fields in the snapshot object', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({
          inputGuardMode: 'log_only',
          outputGuardMode: 'block',
          maxHistoryTokens: 4000,
          retentionDays: 90,
          providerConfig: { timeout: 3000 },
          monthlyBudgetUsd: 50,
        }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ monthlyBudgetUsd: 100 }) as never
      );

      await PATCH(makeRequest('PATCH', { monthlyBudgetUsd: 100 }), makeParams(AGENT_ID));

      expect(prisma.aiAgentVersion.create).toHaveBeenCalledOnce();
      const createCall = vi.mocked(prisma.aiAgentVersion.create).mock.calls[0][0];
      const snapshot = createCall.data.snapshot as Record<string, unknown>;
      expect(snapshot).toHaveProperty('inputGuardMode', 'log_only');
      expect(snapshot).toHaveProperty('outputGuardMode', 'block');
      expect(snapshot).toHaveProperty('maxHistoryTokens', 4000);
      expect(snapshot).toHaveProperty('retentionDays', 90);
      expect(snapshot).toHaveProperty('providerConfig', { timeout: 3000 });
      expect(snapshot).toHaveProperty('monthlyBudgetUsd', 50);
    });

    it('captures the three attachment-input toggles in the snapshot', async () => {
      // Toggles drive runtime behaviour (the chat handler refuses
      // attachments when these are off), so they belong in the diff
      // viewer. Regression guard against re-omitting them when the
      // snapshot blob is extended in future.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({
          enableVoiceInput: true,
          enableImageInput: true,
          enableDocumentInput: false,
        }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ enableDocumentInput: true }) as never
      );

      await PATCH(makeRequest('PATCH', { enableDocumentInput: true }), makeParams(AGENT_ID));

      expect(prisma.aiAgentVersion.create).toHaveBeenCalledOnce();
      const createCall = vi.mocked(prisma.aiAgentVersion.create).mock.calls[0][0];
      const snapshot = createCall.data.snapshot as Record<string, unknown>;
      // Snapshot is of the PRE-update state, so we expect the values
      // that were live on the agent before this PATCH ran.
      expect(snapshot).toHaveProperty('enableVoiceInput', true);
      expect(snapshot).toHaveProperty('enableImageInput', true);
      expect(snapshot).toHaveProperty('enableDocumentInput', false);
    });

    it('does NOT create a version snapshot for non-versioned field changes (name)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent({ name: 'Renamed' }) as never);

      await PATCH(makeRequest('PATCH', { name: 'Renamed' }), makeParams(AGENT_ID));

      expect(prisma.aiAgentVersion.create).not.toHaveBeenCalled();
    });

    it('does NOT create a version when a versioned field is sent with the same value (no-op save)', async () => {
      // Regression for the false "X changed" entries: the form sends
      // back its full state on every save, so every versioned field is
      // present in `data`. Pre-fix, this triggered a version with a
      // change summary like "model changed, temperature changed, …"
      // for a no-op save. Post-fix, the route compares each field
      // against the stored row and only counts genuine changes.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const stored = makeAgent({
        model: 'claude-sonnet-4-6',
        temperature: 0.7,
        maxTokens: 4096,
        provider: 'anthropic',
        visibility: 'internal',
        inputGuardMode: 'log_only',
        outputGuardMode: null,
        citationGuardMode: null,
        maxHistoryTokens: 8000,
        retentionDays: 30,
        fallbackProviders: ['openai'],
        knowledgeCategories: ['docs'],
        topicBoundaries: ['orders'],
        brandVoiceInstructions: 'Be concise.',
        providerConfig: { timeout: 2000 },
        monthlyBudgetUsd: 25,
        rateLimitRpm: 60,
        metadata: { foo: 'bar' },
      });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(stored as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(stored as never);

      // Form-shaped PATCH echoing every versioned field at its current value.
      await PATCH(
        makeRequest('PATCH', {
          model: 'claude-sonnet-4-6',
          temperature: 0.7,
          maxTokens: 4096,
          provider: 'anthropic',
          visibility: 'internal',
          inputGuardMode: 'log_only',
          outputGuardMode: null,
          citationGuardMode: null,
          maxHistoryTokens: 8000,
          retentionDays: 30,
          fallbackProviders: ['openai'],
          knowledgeCategories: ['docs'],
          topicBoundaries: ['orders'],
          brandVoiceInstructions: 'Be concise.',
          providerConfig: { timeout: 2000 },
          monthlyBudgetUsd: 25,
          rateLimitRpm: 60,
          metadata: { foo: 'bar' },
        }),
        makeParams(AGENT_ID)
      );

      expect(prisma.aiAgentVersion.create).not.toHaveBeenCalled();
    });

    it('creates a version only for fields that actually changed (mixed payload)', async () => {
      // Mixed payload: 4 versioned fields supplied, 3 unchanged and 1
      // genuinely different. The change summary must list only the
      // differing one, not all four.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({
          model: 'claude-sonnet-4-6',
          temperature: 0.7,
          maxTokens: 4096,
          visibility: 'internal',
        }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ visibility: 'public' }) as never
      );

      await PATCH(
        makeRequest('PATCH', {
          model: 'claude-sonnet-4-6', // unchanged
          temperature: 0.7, // unchanged
          maxTokens: 4096, // unchanged
          visibility: 'public', // changed
        }),
        makeParams(AGENT_ID)
      );

      expect(prisma.aiAgentVersion.create).toHaveBeenCalledOnce();
      const createCall = vi.mocked(prisma.aiAgentVersion.create).mock.calls[0][0];
      expect(createCall.data.changeSummary).toBe('visibility changed');
    });

    it('treats string[] order-equal arrays as unchanged (fallbackProviders)', async () => {
      // Form sends arrays back as arrays; if the elements and order
      // match, this counts as no-op even though the reference identity
      // differs.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({ fallbackProviders: ['openai', 'groq'] }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent() as never);

      await PATCH(
        makeRequest('PATCH', { fallbackProviders: ['openai', 'groq'] }),
        makeParams(AGENT_ID)
      );

      expect(prisma.aiAgentVersion.create).not.toHaveBeenCalled();
    });

    it('detects array reorder as a change (fallbackProviders priority matters)', async () => {
      // For fallbackProviders specifically, order is the priority list,
      // so swapping ['openai','groq'] → ['groq','openai'] IS a change.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({ fallbackProviders: ['openai', 'groq'] }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent() as never);

      await PATCH(
        makeRequest('PATCH', { fallbackProviders: ['groq', 'openai'] }),
        makeParams(AGENT_ID)
      );

      expect(prisma.aiAgentVersion.create).toHaveBeenCalledOnce();
    });
  });

  describe('enableVoiceInput field', () => {
    it('persists enableVoiceInput=true via PATCH', async () => {
      // Regression: pre-fix the PATCH route had no `if
      // (body.enableVoiceInput !== undefined)` branch, so toggling the
      // switch on the agent form silently dropped on the floor. The
      // Zod schema and form both honoured the field — only the route
      // ignored it.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({ enableVoiceInput: false }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ enableVoiceInput: true }) as never
      );

      await PATCH(makeRequest('PATCH', { enableVoiceInput: true }), makeParams(AGENT_ID));

      expect(prisma.aiAgent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ enableVoiceInput: true }) })
      );
    });

    it('persists enableVoiceInput=false (turn voice off)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({ enableVoiceInput: true }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ enableVoiceInput: false }) as never
      );

      await PATCH(makeRequest('PATCH', { enableVoiceInput: false }), makeParams(AGENT_ID));

      expect(prisma.aiAgent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ enableVoiceInput: false }) })
      );
    });

    it('creates a version snapshot when enableVoiceInput changes and lists it in the summary', async () => {
      // The user-visible bug: toggling voice on/off persisted but the
      // version history tab showed nothing. enableVoiceInput needs to
      // be in VERSIONED_FIELDS and the snapshot block.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgent({ enableVoiceInput: false }) as never
      );
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(
        makeAgent({ enableVoiceInput: true }) as never
      );

      await PATCH(makeRequest('PATCH', { enableVoiceInput: true }), makeParams(AGENT_ID));

      expect(prisma.aiAgentVersion.create).toHaveBeenCalledOnce();
      const createCall = vi.mocked(prisma.aiAgentVersion.create).mock.calls[0][0];
      expect(createCall.data.changeSummary).toContain('enableVoiceInput changed');
      const snapshot = createCall.data.snapshot as Record<string, unknown>;
      expect(snapshot).toHaveProperty('enableVoiceInput', false); // pre-update value
    });
  });

  describe('Snapshot completeness — every versioned field is captured', () => {
    // Belt-and-braces: when any versioned field changes, the snapshot
    // must include the pre-update value of every other versioned field
    // so a future restore round-trips cleanly. Catches the regression
    // where a new field is added to VERSIONED_FIELDS but forgotten in
    // the snapshot object (or vice versa).
    it('snapshot object carries every key in VERSIONED_FIELDS', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const stored = makeAgent({
        systemInstructions: 'sys',
        model: 'm',
        temperature: 0.5,
        maxTokens: 1000,
        topicBoundaries: ['a'],
        brandVoiceInstructions: 'bv',
        provider: 'anthropic',
        fallbackProviders: ['openai'],
        knowledgeCategories: ['docs'],
        rateLimitRpm: 30,
        visibility: 'internal',
        inputGuardMode: 'log_only',
        outputGuardMode: 'log_only',
        citationGuardMode: 'log_only',
        maxHistoryTokens: 4000,
        retentionDays: 60,
        providerConfig: { t: 1 },
        monthlyBudgetUsd: 10,
        metadata: { tag: 'x' },
        enableVoiceInput: true,
      });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(stored as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent({ temperature: 0.9 }) as never);

      // Trigger via any single change.
      await PATCH(makeRequest('PATCH', { temperature: 0.9 }), makeParams(AGENT_ID));

      const createCall = vi.mocked(prisma.aiAgentVersion.create).mock.calls[0][0];
      const snapshot = createCall.data.snapshot as Record<string, unknown>;
      // The exhaustive set the route should snapshot. If this list
      // diverges from VERSIONED_FIELDS in route.ts, one of them is
      // wrong — both must be kept in lockstep.
      const expected = [
        'systemInstructions',
        'model',
        'temperature',
        'maxTokens',
        'topicBoundaries',
        'brandVoiceInstructions',
        'provider',
        'fallbackProviders',
        'knowledgeCategories',
        'rateLimitRpm',
        'visibility',
        'inputGuardMode',
        'outputGuardMode',
        'citationGuardMode',
        'maxHistoryTokens',
        'retentionDays',
        'providerConfig',
        'monthlyBudgetUsd',
        'metadata',
        'enableVoiceInput',
      ];
      for (const key of expected) {
        expect(snapshot).toHaveProperty(key);
      }
      // Spot-check a few values to confirm it's the pre-update state,
      // not an empty placeholder.
      expect(snapshot).toHaveProperty('temperature', 0.5);
      expect(snapshot).toHaveProperty('enableVoiceInput', true);
      expect(snapshot).toHaveProperty('providerConfig', { t: 1 });
    });
  });
});

describe('DELETE /api/v1/admin/orchestration/agents/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await DELETE(makeRequest('DELETE'), makeParams(AGENT_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await DELETE(makeRequest('DELETE'), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded on DELETE', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await DELETE(makeRequest('DELETE'), makeParams(AGENT_ID));

      expect(response.status).toBe(429);
      expect(vi.mocked(prisma.aiAgent.findUnique)).not.toHaveBeenCalled();
    });
  });

  describe('Successful soft delete', () => {
    it('sets isActive to false and returns success', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgent() as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgent({ isActive: false }) as never);

      const response = await DELETE(makeRequest('DELETE'), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { isActive: boolean } }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data.isActive).toBe(false);

      // Verify the update was called with isActive: false
      expect(vi.mocked(prisma.aiAgent.update)).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } })
      );
    });
  });

  describe('Error cases', () => {
    it('returns 404 when agent not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

      const response = await DELETE(makeRequest('DELETE'), makeParams(AGENT_ID));

      expect(response.status).toBe(404);
    });
  });
});
