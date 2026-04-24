/**
 * Integration Test: Admin Orchestration Agent Instructions Revert
 *
 * POST /api/v1/admin/orchestration/agents/:id/instructions-revert
 *   Body: { versionIndex: number }
 *
 * Critical: Pushes the CURRENT instructions onto history BEFORE overwriting
 * with the target version, ensuring the reverted-from value is never lost.
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/instructions-revert/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/agents/[id]/instructions-revert/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

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
  },
}));

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

const HISTORY_V0 = {
  instructions: 'Version 0 instructions.',
  changedAt: '2025-01-01T00:00:00.000Z',
  changedBy: ADMIN_ID,
};
const HISTORY_V1 = {
  instructions: 'Version 1 instructions.',
  changedAt: '2025-02-01T00:00:00.000Z',
  changedBy: ADMIN_ID,
};

function makeAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    systemInstructions: 'Current instructions.',
    systemInstructionsHistory: [HISTORY_V0, HISTORY_V1],
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/instructions-revert`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/agents/:id/instructions-revert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makeRequest({ versionIndex: 0 }), makeParams(AGENT_ID));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makeRequest({ versionIndex: 0 }), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST (mutating route)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow() as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(makeAgentRow() as never);

      await POST(makeRequest({ versionIndex: 0 }), makeParams(AGENT_ID));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });

  describe('Critical: revert writes current instructions to history BEFORE overwriting', () => {
    it('pushes current instructions onto history before writing target version', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const agent = makeAgentRow({
        systemInstructions: 'Current instructions.',
        systemInstructionsHistory: [HISTORY_V0, HISTORY_V1],
      });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(agent as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(agent as never);

      // Revert to index 0 (HISTORY_V0)
      const response = await POST(makeRequest({ versionIndex: 0 }), makeParams(AGENT_ID));

      expect(response.status).toBe(200);

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];

      // The new systemInstructions should be the target version's instructions
      expect(updateCall.data.systemInstructions).toBe(HISTORY_V0.instructions);

      // The history should be [original entries..., {current instructions pushed}]
      const newHistory = updateCall.data.systemInstructionsHistory as Array<{
        instructions: string;
        changedBy: string;
        changedAt: string;
      }>;
      expect(Array.isArray(newHistory)).toBe(true);
      expect(newHistory).toHaveLength(3); // original 2 + 1 new entry
      expect(newHistory[0]).toEqual(HISTORY_V0);
      expect(newHistory[1]).toEqual(HISTORY_V1);
      // The last entry is the value we're reverting FROM
      expect(newHistory[2].instructions).toBe('Current instructions.');
      expect(newHistory[2].changedBy).toBe(ADMIN_ID);
      expect(newHistory[2].changedAt).toBeDefined();
    });

    it('reverts to the correct version when versionIndex is 1', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const agent = makeAgentRow({
        systemInstructions: 'Current instructions.',
        systemInstructionsHistory: [HISTORY_V0, HISTORY_V1],
      });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(agent as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(agent as never);

      await POST(makeRequest({ versionIndex: 1 }), makeParams(AGENT_ID));

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      // Should revert to HISTORY_V1's instructions
      expect(updateCall.data.systemInstructions).toBe(HISTORY_V1.instructions);
    });

    it('produces history with length history.length + 1 after revert', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const originalHistory = [HISTORY_V0, HISTORY_V1];
      const agent = makeAgentRow({
        systemInstructions: 'Current instructions.',
        systemInstructionsHistory: originalHistory,
      });
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(agent as never);
      vi.mocked(prisma.aiAgent.update).mockResolvedValue(agent as never);

      await POST(makeRequest({ versionIndex: 0 }), makeParams(AGENT_ID));

      const updateCall = vi.mocked(prisma.aiAgent.update).mock.calls[0][0];
      const newHistory = updateCall.data.systemInstructionsHistory as unknown[];
      expect(newHistory).toHaveLength(originalHistory.length + 1);
    });
  });

  describe('Validation: versionIndex out of range', () => {
    it('returns 400 when versionIndex equals history.length', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // History has 2 entries: valid indices are 0 and 1
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgentRow({ systemInstructionsHistory: [HISTORY_V0, HISTORY_V1] }) as never
      );

      // Index 2 is out of range
      const response = await POST(makeRequest({ versionIndex: 2 }), makeParams(AGENT_ID));

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 when versionIndex is greater than history.length', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgentRow({ systemInstructionsHistory: [HISTORY_V0] }) as never
      );

      const response = await POST(makeRequest({ versionIndex: 99 }), makeParams(AGENT_ID));

      expect(response.status).toBe(400);
    });

    it('returns 400 with clear message when history is empty', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
        makeAgentRow({ systemInstructionsHistory: [] }) as never
      );

      // Index 0 is out of range when history is empty
      const response = await POST(makeRequest({ versionIndex: 0 }), makeParams(AGENT_ID));

      expect(response.status).toBe(400);
      const data = await parseJson(response);
      expect(data).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('No instruction history') },
      });
    });
  });

  describe('Error cases', () => {
    it('returns 400 for invalid CUID param', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest({ versionIndex: 0 }), makeParams('not-a-cuid'));

      expect(response.status).toBe(400);
    });

    it('returns 404 when agent not found', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

      const response = await POST(makeRequest({ versionIndex: 0 }), makeParams(AGENT_ID));

      expect(response.status).toBe(404);
    });

    it('returns 400 for missing versionIndex', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest({}), makeParams(AGENT_ID));

      expect(response.status).toBe(400);
    });
  });
});
