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

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    aiAgentVersion: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
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
