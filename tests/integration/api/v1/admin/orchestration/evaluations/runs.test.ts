/**
 * Integration Test: Admin Orchestration — Evaluation Runs (list + create)
 *
 * GET  /api/v1/admin/orchestration/evaluations/runs
 * POST /api/v1/admin/orchestration/evaluations/runs
 *
 * @see app/api/v1/admin/orchestration/evaluations/runs/route.ts
 *
 * Coverage matrix:
 * - 401 / 403 / 400 on auth + validation
 * - GET: list with userId scoping; status, subjectKind, datasetId, agentId filters
 * - POST happy path (201, queued)
 * - POST preflight: unknown grader slug → 400
 * - POST preflight: dataset not owned → 404
 * - POST preflight: reference-required grader without expectedOutput → 400
 * - POST preflight: subject agent not found → 404
 * - POST preflight: subject is judge (kind!=chat) → 400
 * - POST preflight: subjectKind=workflow → 400 (Phase 1 boundary)
 * - POST preflight: judge_agent slug not found → 400
 * - POST preflight: judge_agent slug is non-judge → 400
 * - POST preflight: judge_agent is inactive → 400
 * - POST: brand-voice judge interpolates subjectBrandVoice into pinned config
 * - POST: heuristic grader (no judge) skips judge resolution
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/evaluations/runs/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { z } from 'zod';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEvaluationRun: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    aiDataset: { findFirst: vi.fn() },
    aiDatasetCase: { count: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/evaluations/graders', () => ({
  hasGrader: vi.fn(),
  getGrader: vi.fn(),
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
import { hasGrader, getGrader } from '@/lib/orchestration/evaluations/graders';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const RUN_ID = 'cmjbv4i3x00003wsloputgwu1';
const DATASET_ID = 'cmjbv4i3x00003wsloputgwu7';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    userId: ADMIN_ID,
    name: 'My Run',
    description: null,
    subjectKind: 'agent',
    agentId: AGENT_ID,
    workflowId: null,
    datasetId: DATASET_ID,
    datasetContentHash: 'hash-stub',
    metricConfigs: [{ slug: 'exact_match', config: {} }],
    judgeProvider: null,
    judgeModel: null,
    status: 'queued',
    progress: { casesTotal: 3, casesDone: 0, casesFailed: 0 },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeHeuristicGrader(overrides: Partial<{ referenceRequired: boolean }> = {}) {
  return {
    slug: 'exact_match',
    family: 'heuristic',
    description: 'exact match grader',
    referenceRequired: overrides.referenceRequired ?? true,
    configSchema: z.object({}).passthrough(),
    defaultConfig: {},
  };
}

function makeJudgeGrader() {
  return {
    slug: 'judge_agent',
    family: 'model',
    description: 'judge agent grader',
    referenceRequired: false,
    configSchema: z
      .object({ agentSlug: z.string(), subjectBrandVoice: z.string().optional() })
      .passthrough(),
    defaultConfig: {},
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(query: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/evaluations/runs');
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/evaluations/runs',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

function validRunBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'My Run',
    subjectKind: 'agent',
    agentId: AGENT_ID,
    datasetId: DATASET_ID,
    metricConfigs: [{ slug: 'exact_match', config: {} }],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/evaluations/runs', () => {
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

  it('always scopes WHERE clause to session.user.id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEvaluationRun.count).mockResolvedValue(0);

    await GET(makeGetRequest());

    expect(vi.mocked(prisma.aiEvaluationRun.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: ADMIN_ID }),
      })
    );
  });

  it('returns 200 with paginated runs', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findMany).mockResolvedValue([makeRunRow()] as never);
    vi.mocked(prisma.aiEvaluationRun.count).mockResolvedValue(1);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const data = await parseJson<{ data: Array<{ id: string }>; meta: { total: number } }>(
      response
    );
    expect(data.data).toHaveLength(1);
    expect(data.data[0].id).toBe(RUN_ID);
    expect(data.meta.total).toBe(1);
  });

  it('applies status, subjectKind, datasetId, agentId filters', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEvaluationRun.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEvaluationRun.count).mockResolvedValue(0);

    await GET(
      makeGetRequest({
        status: 'queued',
        subjectKind: 'agent',
        datasetId: DATASET_ID,
        agentId: AGENT_ID,
      })
    );

    expect(vi.mocked(prisma.aiEvaluationRun.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: ADMIN_ID,
          status: 'queued',
          subjectKind: 'agent',
          datasetId: DATASET_ID,
          agentId: AGENT_ID,
        }),
      })
    );
  });

  it('returns 400 on invalid status filter', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeGetRequest({ status: 'banana' }));

    expect(response.status).toBe(400);
  });
});

describe('POST /api/v1/admin/orchestration/evaluations/runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default registry state: exact_match grader exists and is reference-required.
    vi.mocked(hasGrader).mockImplementation((slug: string) =>
      ['exact_match', 'judge_agent', 'contains'].includes(slug)
    );
    vi.mocked(getGrader).mockImplementation((slug: string) => {
      if (slug === 'judge_agent') return makeJudgeGrader() as never;
      if (slug === 'contains')
        return { ...makeHeuristicGrader({ referenceRequired: false }), slug: 'contains' } as never;
      return makeHeuristicGrader() as never;
    });
  });

  // ─── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makePostRequest(validRunBody()));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await POST(makePostRequest(validRunBody()));

    expect(response.status).toBe(403);
  });

  // ─── Body validation (Zod) ────────────────────────────────────────────────

  it('returns 400 when name is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makePostRequest(validRunBody({ name: undefined })));

    expect(response.status).toBe(400);
  });

  it('returns 400 when metricConfigs array is empty', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makePostRequest(validRunBody({ metricConfigs: [] })));

    expect(response.status).toBe(400);
  });

  it('returns 400 when subjectKind=agent without agentId', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makePostRequest(validRunBody({ agentId: undefined, workflowId: undefined }))
    );

    expect(response.status).toBe(400);
  });

  // ─── Preflight: graders ───────────────────────────────────────────────────

  it('returns 400 when grader slug is unknown', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(hasGrader).mockReturnValue(false);

    const response = await POST(
      makePostRequest(validRunBody({ metricConfigs: [{ slug: 'mystery' }] }))
    );

    expect(response.status).toBe(400);
    const data = await parseJson<{ error: { code: string; message: string } }>(response);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.message).toContain('mystery');
  });

  // ─── Preflight: dataset ownership ─────────────────────────────────────────

  it('returns 404 when dataset is owned by a different user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null);

    const response = await POST(makePostRequest(validRunBody()));

    expect(response.status).toBe(404);
    expect(vi.mocked(prisma.aiDataset.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: DATASET_ID, userId: ADMIN_ID }),
      })
    );
  });

  // ─── Preflight: reference-required graders need expectedOutput ────────────

  it('returns 400 when reference-required grader and dataset has cases missing expectedOutput', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 3,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(2); // 2 cases lack expectedOutput

    const response = await POST(makePostRequest(validRunBody()));

    expect(response.status).toBe(400);
    const data = await parseJson<{ error: { message: string } }>(response);
    expect(data.error.message).toContain('expectedOutput');
    expect(vi.mocked(prisma.aiEvaluationRun.create)).not.toHaveBeenCalled();
  });

  it('skips the reference-required check when no graders need it', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 3,
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: AGENT_ID,
      kind: 'chat',
      brandVoiceInstructions: null,
    } as never);
    vi.mocked(prisma.aiEvaluationRun.create).mockResolvedValue(makeRunRow() as never);

    const response = await POST(
      makePostRequest(validRunBody({ metricConfigs: [{ slug: 'contains', config: {} }] }))
    );

    expect(response.status).toBe(201);
    expect(vi.mocked(prisma.aiDatasetCase.count)).not.toHaveBeenCalled();
  });

  // ─── Preflight: subject agent ─────────────────────────────────────────────

  it('returns 404 when subject agent does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 1,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const response = await POST(makePostRequest(validRunBody()));

    expect(response.status).toBe(404);
  });

  it('returns 400 when subject agent is a judge (kind != chat)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 1,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: AGENT_ID,
      kind: 'judge',
      brandVoiceInstructions: null,
    } as never);

    const response = await POST(makePostRequest(validRunBody()));

    expect(response.status).toBe(400);
    const data = await parseJson<{ error: { message: string } }>(response);
    expect(data.error.message).toContain('chat agent');
  });

  // ─── Preflight: workflow subject rejected at Phase 1 boundary ─────────────

  it('returns 400 when subjectKind=workflow (Phase 1 boundary)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 1,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);

    const response = await POST(
      makePostRequest(
        validRunBody({
          subjectKind: 'workflow',
          agentId: undefined,
          workflowId: 'cmjbv4i3x00003wsloputgwu9',
        })
      )
    );

    expect(response.status).toBe(400);
    const data = await parseJson<{ error: { message: string } }>(response);
    expect(data.error.message).toContain('Phase 3');
  });

  // ─── Preflight: judge_agent slug resolution ───────────────────────────────

  it('returns 400 when judge_agent slug does not resolve to an agent', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 1,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);
    (
      prisma.aiAgent.findUnique as unknown as {
        mockImplementation: (fn: (args: unknown) => Promise<unknown>) => void;
      }
    ).mockImplementation(async (args: unknown) => {
      const a = args as { where: { id?: string; slug?: string } };
      if (a.where.id === AGENT_ID) {
        return { id: AGENT_ID, kind: 'chat', brandVoiceInstructions: null } as never;
      }
      // judge slug lookup returns null
      return null;
    });

    const response = await POST(
      makePostRequest(
        validRunBody({
          metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'missing-judge' } }],
        })
      )
    );

    expect(response.status).toBe(400);
    const data = await parseJson<{ error: { message: string } }>(response);
    expect(data.error.message).toContain('missing-judge');
  });

  it('returns 400 when judge_agent slug points to a non-judge agent', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 1,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);
    (
      prisma.aiAgent.findUnique as unknown as {
        mockImplementation: (fn: (args: unknown) => Promise<unknown>) => void;
      }
    ).mockImplementation(async (args: unknown) => {
      const a = args as { where: { id?: string; slug?: string } };
      if (a.where.id === AGENT_ID) {
        return { id: AGENT_ID, kind: 'chat', brandVoiceInstructions: null } as never;
      }
      return { kind: 'chat', isActive: true } as never; // wrong kind
    });

    const response = await POST(
      makePostRequest(
        validRunBody({
          metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'wrong-kind' } }],
        })
      )
    );

    expect(response.status).toBe(400);
    const data = await parseJson<{ error: { message: string } }>(response);
    expect(data.error.message).toContain('not a judge');
  });

  it('returns 400 when judge_agent slug is inactive', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 1,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);
    (
      prisma.aiAgent.findUnique as unknown as {
        mockImplementation: (fn: (args: unknown) => Promise<unknown>) => void;
      }
    ).mockImplementation(async (args: unknown) => {
      const a = args as { where: { id?: string; slug?: string } };
      if (a.where.id === AGENT_ID) {
        return { id: AGENT_ID, kind: 'chat', brandVoiceInstructions: null } as never;
      }
      return { kind: 'judge', isActive: false } as never;
    });

    const response = await POST(
      makePostRequest(
        validRunBody({
          metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'sleeping-judge' } }],
        })
      )
    );

    expect(response.status).toBe(400);
    const data = await parseJson<{ error: { message: string } }>(response);
    expect(data.error.message).toContain('inactive');
  });

  // ─── Per-grader config schema validation ──────────────────────────────────

  it("returns 400 when a grader's per-entry config fails its own configSchema", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 1,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: AGENT_ID,
      kind: 'chat',
      brandVoiceInstructions: null,
    } as never);
    // Swap the contains grader for a strict configSchema that rejects {}.
    vi.mocked(getGrader).mockImplementation((slug: string) => {
      if (slug === 'contains') {
        return {
          slug: 'contains',
          family: 'heuristic',
          description: 'contains grader',
          referenceRequired: false,
          configSchema: z.object({ needle: z.string() }), // required field
          defaultConfig: undefined,
        } as never;
      }
      return makeHeuristicGrader() as never;
    });

    const response = await POST(
      makePostRequest(validRunBody({ metricConfigs: [{ slug: 'contains', config: {} }] }))
    );

    expect(response.status).toBe(400);
    const data = await parseJson<{ error: { code: string; message: string } }>(response);
    expect(data.error.code).toBe('VALIDATION_ERROR');
    expect(data.error.message).toContain('contains');
    expect(data.error.message).toContain('config invalid');
    expect(vi.mocked(prisma.aiEvaluationRun.create)).not.toHaveBeenCalled();
  });

  // ─── Brand-voice judge: subjectBrandVoice pinning ─────────────────────────

  it('pins subjectBrandVoice into config when the brand-voice judge is selected', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 1,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);
    (
      prisma.aiAgent.findUnique as unknown as {
        mockImplementation: (fn: (args: unknown) => Promise<unknown>) => void;
      }
    ).mockImplementation(async (args: unknown) => {
      const a = args as { where: { id?: string; slug?: string } };
      if (a.where.id === AGENT_ID) {
        return {
          id: AGENT_ID,
          kind: 'chat',
          brandVoiceInstructions: 'Friendly and concise.',
        } as never;
      }
      return { kind: 'judge', isActive: true } as never;
    });
    vi.mocked(prisma.aiEvaluationRun.create).mockResolvedValue(makeRunRow() as never);

    const response = await POST(
      makePostRequest(
        validRunBody({
          metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: 'eval-judge-brand-voice' } }],
        })
      )
    );

    expect(response.status).toBe(201);
    expect(vi.mocked(prisma.aiEvaluationRun.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metricConfigs: [
            {
              slug: 'judge_agent',
              config: {
                agentSlug: 'eval-judge-brand-voice',
                subjectBrandVoice: 'Friendly and concise.',
              },
            },
          ],
        }),
      })
    );
  });

  it('does NOT pin subjectBrandVoice for a non-brand-voice judge', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'h',
      caseCount: 1,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);
    (
      prisma.aiAgent.findUnique as unknown as {
        mockImplementation: (fn: (args: unknown) => Promise<unknown>) => void;
      }
    ).mockImplementation(async (args: unknown) => {
      const a = args as { where: { id?: string; slug?: string } };
      if (a.where.id === AGENT_ID) {
        return {
          id: AGENT_ID,
          kind: 'chat',
          brandVoiceInstructions: 'Friendly and concise.',
        } as never;
      }
      return { kind: 'judge', isActive: true } as never;
    });
    vi.mocked(prisma.aiEvaluationRun.create).mockResolvedValue(makeRunRow() as never);

    await POST(
      makePostRequest(
        validRunBody({
          metricConfigs: [
            { slug: 'judge_agent', config: { agentSlug: 'eval-judge-faithfulness' } },
          ],
        })
      )
    );

    expect(vi.mocked(prisma.aiEvaluationRun.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metricConfigs: [
            { slug: 'judge_agent', config: { agentSlug: 'eval-judge-faithfulness' } },
          ],
        }),
      })
    );
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  it('returns 201 and queues the run with status=queued + content-hash pin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({
      id: DATASET_ID,
      contentHash: 'pinned-hash',
      caseCount: 3,
    } as never);
    vi.mocked(prisma.aiDatasetCase.count).mockResolvedValue(0);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: AGENT_ID,
      kind: 'chat',
      brandVoiceInstructions: null,
    } as never);
    vi.mocked(prisma.aiEvaluationRun.create).mockResolvedValue(
      makeRunRow({ datasetContentHash: 'pinned-hash' }) as never
    );

    const response = await POST(makePostRequest(validRunBody()));

    expect(response.status).toBe(201);
    const data = await parseJson<{ data: { id: string; status: string } }>(response);
    expect(data.data.id).toBe(RUN_ID);
    expect(data.data.status).toBe('queued');
    expect(vi.mocked(prisma.aiEvaluationRun.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: ADMIN_ID,
          datasetId: DATASET_ID,
          datasetContentHash: 'pinned-hash',
          status: 'queued',
          progress: { casesTotal: 3, casesDone: 0, casesFailed: 0 },
        }),
      })
    );
  });
});
