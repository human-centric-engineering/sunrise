/**
 * Integration tests: cold-start dataset creation routes (Phase 3.6).
 *
 *   POST /api/v1/admin/orchestration/evaluations/datasets/generate-from-description
 *   POST /api/v1/admin/orchestration/evaluations/datasets/generate-from-description/commit
 *
 * Coverage:
 * - Preview: 401/403, rate-limit cap, body validation, agent existence
 * - Preview happy path returns generator output verbatim
 * - Commit: 400 on bad payload, 201 happy path creates dataset + cases atomically
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
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
    aiDataset: { create: vi.fn() },
    aiDatasetCase: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/evaluations/synthesis/case-generator', () => ({
  generateCases: vi.fn(),
}));

const { synthesisCheck } = vi.hoisted(() => ({ synthesisCheck: vi.fn() }));
vi.mock('@/lib/security/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
    '@/lib/security/rate-limit'
  );
  return {
    ...actual,
    synthesisLimiter: { check: synthesisCheck, reset: vi.fn() },
  };
});

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { generateCases } from '@/lib/orchestration/evaluations/synthesis/case-generator';
import { POST as PreviewPOST } from '@/app/api/v1/admin/orchestration/evaluations/datasets/generate-from-description/route';
import { POST as CommitPOST } from '@/app/api/v1/admin/orchestration/evaluations/datasets/generate-from-description/commit/route';

const VALID_DOMAIN_PROMPT =
  'Customer support agent for a fintech card issuer. Handles disputes, declines, fees, refunds.';

function makeRequest(body: Record<string, unknown>, suffix = ''): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets/generate-from-description${suffix}`,
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  synthesisCheck.mockReturnValue({
    success: true,
    remaining: 9,
    reset: Date.now() + 60_000,
    limit: 10,
  });
});

describe('POST /generate-from-description (preview) — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await PreviewPOST(makeRequest({ agentId: 'a', domainPrompt: VALID_DOMAIN_PROMPT }));
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await PreviewPOST(makeRequest({ agentId: 'a', domainPrompt: VALID_DOMAIN_PROMPT }));
    expect(res.status).toBe(403);
  });
});

describe('POST /generate-from-description (preview) — rate limit', () => {
  it('returns 429 when synthesisLimiter rejects', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    synthesisCheck.mockReturnValue({
      success: false,
      remaining: 0,
      reset: Date.now() + 60_000,
      limit: 10,
    });

    const res = await PreviewPOST(makeRequest({ agentId: 'a', domainPrompt: VALID_DOMAIN_PROMPT }));

    expect(res.status).toBe(429);
    expect(vi.mocked(generateCases)).not.toHaveBeenCalled();
  });
});

describe('POST /generate-from-description (preview) — validation + ownership', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 400 on a missing domainPrompt', async () => {
    const res = await PreviewPOST(makeRequest({ agentId: 'a' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when domainPrompt is below the min length', async () => {
    const res = await PreviewPOST(makeRequest({ agentId: 'a', domainPrompt: 'too short' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the subject agent does not exist', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
    const res = await PreviewPOST(
      makeRequest({ agentId: 'missing', domainPrompt: VALID_DOMAIN_PROMPT })
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /generate-from-description (preview) — happy path', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'a' } as never);
  });

  it('passes mode=description + body fields to generateCases and returns the result', async () => {
    const fakeResult = {
      cases: [
        {
          input: 'Why was my transaction declined?',
          expectedOutput: 'Most declines are insufficient funds, card limits, or fraud holds.',
          metadata: { source: 'synthetic', mode: 'description', intent: 'declines' },
        },
      ],
      costUsd: 0.004,
      tokenUsage: { input: 120, output: 80 },
    };
    vi.mocked(generateCases).mockResolvedValue(fakeResult);

    const res = await PreviewPOST(
      makeRequest({
        agentId: 'a',
        count: 1,
        domainPrompt: VALID_DOMAIN_PROMPT,
        seedInputs: ['My card was declined at checkout'],
      })
    );

    expect(res.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: typeof fakeResult }>(res);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(fakeResult);
    expect(vi.mocked(generateCases)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'a',
        mode: 'description',
        count: 1,
        domainPrompt: VALID_DOMAIN_PROMPT,
        seedInputs: ['My card was declined at checkout'],
      })
    );
  });

  it('omits seedInputs from the call when none are provided', async () => {
    vi.mocked(generateCases).mockResolvedValue({
      cases: [{ input: 'q', expectedOutput: 'a', metadata: {} }],
      costUsd: 0.001,
      tokenUsage: { input: 10, output: 5 },
    });

    await PreviewPOST(makeRequest({ agentId: 'a', domainPrompt: VALID_DOMAIN_PROMPT }));

    const callArgs = vi.mocked(generateCases).mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('seedInputs');
  });
});

describe('POST /generate-from-description/commit — happy path + guardrails', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 400 when cases array is empty', async () => {
    const res = await CommitPOST(makeRequest({ name: 'New dataset', cases: [] }, '/commit'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is missing', async () => {
    const res = await CommitPOST(
      makeRequest({ cases: [{ input: 'q', expectedOutput: 'a' }] }, '/commit')
    );
    expect(res.status).toBe(400);
  });

  it('creates a dataset + cases in one transaction on success', async () => {
    const createdDataset = { id: 'cmtest123' };
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: unknown) => {
      const tx = {
        aiDataset: { create: vi.fn().mockResolvedValue(createdDataset) },
        aiDatasetCase: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      };
      return (cb as (t: typeof tx) => Promise<typeof createdDataset>)(tx);
    });

    const res = await CommitPOST(
      makeRequest(
        {
          name: 'Fintech support cases',
          description: 'Cold-start dataset from description mode',
          cases: [
            { input: 'q1', expectedOutput: 'a1', metadata: { source: 'synthetic' } },
            { input: 'q2', expectedOutput: 'a2', metadata: { source: 'synthetic' } },
          ],
        },
        '/commit'
      )
    );

    expect(res.status).toBe(201);
    const body = await parseJson<{
      success: boolean;
      data: { datasetId: string; caseCount: number };
    }>(res);
    expect(body.success).toBe(true);
    expect(body.data.datasetId).toBe('cmtest123');
    expect(body.data.caseCount).toBe(2);
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1);
  });
});
