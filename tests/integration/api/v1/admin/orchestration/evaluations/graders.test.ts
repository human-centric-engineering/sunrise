/**
 * Integration Test: Admin Orchestration — Graders + Judge Agents
 *
 * GET /api/v1/admin/orchestration/evaluations/graders
 *
 * @see app/api/v1/admin/orchestration/evaluations/graders/route.ts
 *
 * Coverage matrix:
 * - 401 / 403 on auth boundary
 * - heuristic graders filtered from registry (family === 'heuristic')
 * - judge agents fetched from prisma with isActive: true
 * - response shape: { heuristicGraders, judgeAgents }
 * - empty registry + empty judge list path
 * - referenceRequired flag carried through
 * - defaultConfig defaults to null when undefined
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/evaluations/graders/route';
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
    aiAgent: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/evaluations/graders', () => ({
  listGraders: vi.fn(),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { listGraders } from '@/lib/orchestration/evaluations/graders';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/evaluations/graders');
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/evaluations/graders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(403);
  });

  it('returns 200 with heuristic graders + judge agents', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(listGraders).mockReturnValue([
      {
        slug: 'exact_match',
        family: 'heuristic',
        description: 'exact',
        referenceRequired: true,
        defaultConfig: { caseSensitive: false },
      },
      {
        slug: 'contains',
        family: 'heuristic',
        description: 'contains',
        referenceRequired: false,
      },
      {
        // Should be filtered out of heuristicGraders (family !== 'heuristic').
        slug: 'judge_agent',
        family: 'model',
        description: 'judge agent',
      },
    ] as never);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      {
        id: 'a1',
        slug: 'eval-judge-faithfulness',
        name: 'Faithfulness Judge',
        description: 'Built-in',
        isSystem: true,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
      },
    ] as never);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const data = await parseJson<{
      success: boolean;
      data: {
        heuristicGraders: Array<{
          slug: string;
          family: string;
          referenceRequired: boolean;
          defaultConfig: unknown;
        }>;
        judgeAgents: Array<{ slug: string; isSystem: boolean }>;
      };
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data.heuristicGraders).toHaveLength(2);
    expect(data.data.heuristicGraders[0]).toEqual({
      slug: 'exact_match',
      family: 'heuristic',
      description: 'exact',
      referenceRequired: true,
      defaultConfig: { caseSensitive: false },
    });
    // contains has no defaultConfig; route defaults to null.
    expect(data.data.heuristicGraders[1]).toEqual({
      slug: 'contains',
      family: 'heuristic',
      description: 'contains',
      referenceRequired: false,
      defaultConfig: null,
    });
    expect(data.data.judgeAgents).toHaveLength(1);
    expect(data.data.judgeAgents[0].slug).toBe('eval-judge-faithfulness');
    expect(data.data.judgeAgents[0].isSystem).toBe(true);
  });

  it('returns empty arrays when registry + judge list are empty', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(listGraders).mockReturnValue([] as never);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([] as never);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const data = await parseJson<{
      data: { heuristicGraders: unknown[]; judgeAgents: unknown[] };
    }>(response);
    expect(data.data.heuristicGraders).toHaveLength(0);
    expect(data.data.judgeAgents).toHaveLength(0);
  });

  it('queries judge agents with kind=judge + isActive=true, ordered by isSystem desc then name', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(listGraders).mockReturnValue([] as never);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([] as never);

    await GET(makeGetRequest());

    expect(vi.mocked(prisma.aiAgent.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kind: 'judge', isActive: true },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      })
    );
  });

  it('falls back referenceRequired to false when grader entry omits the field', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // No referenceRequired key — route applies the `'referenceRequired' in g` guard.
    vi.mocked(listGraders).mockReturnValue([
      { slug: 'mystery', family: 'heuristic', description: 'no flag' },
    ] as never);
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([] as never);

    const response = await GET(makeGetRequest());

    const data = await parseJson<{
      data: { heuristicGraders: Array<{ referenceRequired: boolean }> };
    }>(response);
    expect(data.data.heuristicGraders[0].referenceRequired).toBe(false);
  });
});
