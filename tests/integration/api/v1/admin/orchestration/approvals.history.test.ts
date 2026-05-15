/**
 * Integration Test: Admin Orchestration — Approval History
 *
 * GET /api/v1/admin/orchestration/approvals/history
 *
 * @see app/api/v1/admin/orchestration/approvals/history/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { GET } from '@/app/api/v1/admin/orchestration/approvals/history/route';
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const APPROVER_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeExecution(traceEntries: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-1',
    workflowId: 'wf-1',
    executionTrace: traceEntries,
    workflow: { name: 'Onboarding' },
    ...overrides,
  };
}

function approvalEntry(overrides: Record<string, unknown> = {}) {
  return {
    stepId: 'approve-step',
    stepType: 'human_approval',
    label: 'Manager review',
    status: 'completed',
    output: { approved: true, notes: 'looks good', actor: `admin:${APPROVER_ID}` },
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2025-01-01T10:00:00.000Z',
    completedAt: '2025-01-01T10:05:00.000Z',
    durationMs: 300_000,
    ...overrides,
  };
}

function makeRequest(search = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/approvals/history${search}`,
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/approvals/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
  });

  it('returns one row per decided human_approval step with derived wait duration', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([approvalEntry()]),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice Approver', email: 'alice@example.com' },
    ] as never);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await parseJson<{
      success: true;
      data: Array<{
        decision: string;
        medium: string;
        approverName: string | null;
        waitDurationMs: number;
      }>;
    }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      decision: 'approved',
      medium: 'admin',
      approverName: 'Alice Approver',
      waitDurationMs: 300_000,
    });
  });

  it('classifies token actors and leaves approverName null', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([
        approvalEntry({
          output: { rejected: true, reason: 'denied via embed', actor: 'token:embed' },
          status: 'rejected',
        }),
      ]),
    ] as never);

    const res = await GET(makeRequest());
    const body = await parseJson<{
      data: Array<{ decision: string; medium: string; approverName: string | null }>;
    }>(res);
    expect(body.data[0]).toMatchObject({
      decision: 'rejected',
      medium: 'token-embed',
      approverName: null,
    });
  });

  it('skips trace entries still awaiting decision', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([approvalEntry({ status: 'awaiting_approval', completedAt: undefined })]),
    ] as never);

    const res = await GET(makeRequest());
    const body = await parseJson<{ data: unknown[] }>(res);
    expect(body.data).toEqual([]);
  });

  it('filters by decision and medium', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution(
        [
          approvalEntry({ stepId: 'admin-approve' }),
          approvalEntry({
            stepId: 'token-reject',
            status: 'rejected',
            output: { rejected: true, reason: 'no', actor: 'token:chat' },
          }),
        ],
        { id: 'exec-mixed' }
      ),
    ] as never);

    const res = await GET(makeRequest('?decision=rejected&medium=token'));
    const body = await parseJson<{ data: Array<{ stepId: string; medium: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].stepId).toBe('token-reject');
  });

  it('returns CSV with attachment headers when format=csv', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([approvalEntry()]),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?format=csv'));
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename="approvals-history-/
    );
    const text = await res.text();
    const [header, row] = text.split('\n');
    expect(header).toContain('decision,medium,approver_name');
    expect(row).toContain('approved');
    expect(row).toContain('Alice');
  });
});
