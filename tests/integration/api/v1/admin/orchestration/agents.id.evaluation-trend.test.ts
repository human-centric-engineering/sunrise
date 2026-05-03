/**
 * Integration Test: Admin Orchestration — Agent Evaluation Trend
 *
 * GET /api/v1/admin/orchestration/agents/:id/evaluation-trend
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/evaluation-trend/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403)
 * - 200 returns sorted trend points (only completed sessions, only with metricSummary)
 * - 200 returns empty array when no completed sessions exist
 * - 404 when the agent doesn't exist
 * - 400 on non-CUID id
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/agents/[id]/evaluation-trend/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn() },
    aiEvaluationSession: { findMany: vi.fn() },
  },
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu1';
const INVALID_ID = 'not-a-cuid';

function makeRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/evaluation-trend`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe('GET /api/v1/admin/orchestration/agents/:id/evaluation-trend', () => {
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

  describe('Successful trend fetch', () => {
    it('returns sorted points for completed sessions with metricSummary', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([
        {
          id: 'sess-a',
          title: 'First eval',
          completedAt: new Date('2026-04-01T10:00:00Z'),
          metricSummary: {
            avgFaithfulness: 0.8,
            avgGroundedness: 0.75,
            avgRelevance: 0.85,
            scoredLogCount: 3,
            judgeProvider: 'anthropic',
            judgeModel: 'claude-sonnet-4-6',
            scoredAt: '2026-04-01T10:01:00Z',
            totalScoringCostUsd: 0.01,
          },
        },
        {
          id: 'sess-b',
          title: 'Second eval',
          completedAt: new Date('2026-04-15T10:00:00Z'),
          metricSummary: {
            avgFaithfulness: 0.92,
            avgGroundedness: 0.88,
            avgRelevance: 0.95,
            scoredLogCount: 5,
            judgeProvider: 'anthropic',
            judgeModel: 'claude-sonnet-4-6',
            scoredAt: '2026-04-15T10:01:00Z',
            totalScoringCostUsd: 0.018,
          },
        },
      ] as never);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const body = await parseJson<{
        success: boolean;
        data: {
          points: Array<{
            sessionId: string;
            avgFaithfulness: number | null;
            scoredLogCount: number;
          }>;
        };
      }>(response);
      expect(body.success).toBe(true);
      expect(body.data.points).toHaveLength(2);
      expect(body.data.points[0].sessionId).toBe('sess-a');
      expect(body.data.points[0].avgFaithfulness).toBe(0.8);
      expect(body.data.points[1].sessionId).toBe('sess-b');
      expect(body.data.points[1].scoredLogCount).toBe(5);
    });

    it('returns an empty array when the agent has no completed sessions', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([] as never);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const body = await parseJson<{ success: boolean; data: { points: unknown[] } }>(response);
      expect(body.data.points).toEqual([]);
    });

    it('scopes the query to the caller user and the completed status', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
      vi.mocked(prisma.aiEvaluationSession.findMany).mockResolvedValue([] as never);

      await GET(makeRequest(), makeParams(AGENT_ID));

      expect(vi.mocked(prisma.aiEvaluationSession.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            agentId: AGENT_ID,
            status: 'completed',
          }),
          orderBy: { completedAt: 'asc' },
        })
      );
    });
  });

  describe('Validation & errors', () => {
    it('returns 404 when the agent does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

      const response = await GET(makeRequest(), makeParams(AGENT_ID));
      expect(response.status).toBe(404);
    });

    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const request = {
        method: 'GET',
        headers: new Headers(),
        url: `http://localhost:3000/api/v1/admin/orchestration/agents/${INVALID_ID}/evaluation-trend`,
      } as unknown as NextRequest;
      const response = await GET(request, makeParams(INVALID_ID));
      expect(response.status).toBe(400);
    });
  });
});
