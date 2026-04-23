/**
 * Integration Test: Admin Orchestration — Agent Budget Status
 *
 * GET /api/v1/admin/orchestration/agents/:id/budget
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/budget/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - 200 happy path: budget set
 * - 200 happy path: budget null → withinBudget: true, limit: null, remaining: null
 * - 404 when checkBudget throws Error('Agent xxx not found')
 * - 400 on non-CUID id
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/agents/[id]/budget/route';
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

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  checkBudget: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn() },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { checkBudget } from '@/lib/orchestration/llm/cost-tracker';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu1';
const INVALID_ID = 'not-a-cuid';

function makeBudgetStatus(withBudget = true) {
  if (withBudget) {
    return { withinBudget: true, spent: 20.0, limit: 100.0, remaining: 80.0 };
  }
  return { withinBudget: true, spent: 0, limit: null, remaining: null };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/budget`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/agents/:id/budget', () => {
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

  describe('Successful responses', () => {
    it('returns 200 with budget status when agent has a budget set', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(checkBudget).mockResolvedValue(makeBudgetStatus(true));

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { withinBudget: boolean; spent: number; limit: number; remaining: number };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.withinBudget).toBe(true);
      expect(data.data.limit).toBe(100.0);
      expect(data.data.remaining).toBe(80.0);
    });

    it('returns 200 with null limit and remaining when agent has no budget', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(checkBudget).mockResolvedValue(makeBudgetStatus(false));

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { withinBudget: boolean; limit: null; remaining: null };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data.withinBudget).toBe(true);
      expect(data.data.limit).toBeNull();
      expect(data.data.remaining).toBeNull();
    });

    it('calls checkBudget with the agent id from the URL', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(checkBudget).mockResolvedValue(makeBudgetStatus(true));

      await GET(makeRequest(), makeParams(AGENT_ID));

      expect(vi.mocked(checkBudget)).toHaveBeenCalledWith(AGENT_ID);
    });
  });

  describe('Not found', () => {
    it('returns 404 when agent does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null as never);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(404);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
