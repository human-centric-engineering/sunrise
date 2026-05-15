/**
 * Integration Test: Admin Orchestration — Approval History
 *
 * GET /api/v1/admin/orchestration/approvals/history
 *
 * @see app/api/v1/admin/orchestration/approvals/history/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

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

// Stub the route logger so log.info calls don't pollute test output.
vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { GET } from '@/app/api/v1/admin/orchestration/approvals/history/route';
import { prisma } from '@/lib/db/client';
import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';

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

  it('neutralises formula-injection payloads in CSV cells', async () => {
    // A hostile approver could set their User.name to a leading-`=`
    // formula; the same risk applies to notes / reason free text. The
    // export must prefix the value with a single quote so Excel /
    // Sheets renders it as literal text rather than evaluating it.
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([
        approvalEntry({
          output: {
            approved: true,
            notes: '=HYPERLINK("https://evil.example","leak")',
            actor: `admin:${APPROVER_ID}`,
          },
        }),
      ]),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: "=cmd|'/c calc'!A1", email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?format=csv'));
    const text = await res.text();
    // The neutralised approver name and notes both carry a leading
    // single-quote inside their quoted cells. No raw leading `=`
    // survives.
    expect(text).toContain("'=cmd");
    expect(text).toContain("'=HYPERLINK");
    expect(text).not.toMatch(/,=cmd/);
    expect(text).not.toMatch(/,=HYPERLINK/);
  });

  // ─── Auth / rate-limit guards ─────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(mockUnauthenticatedUser());
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(mockAuthenticatedUser('USER'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(adminLimiter.check).mockReturnValueOnce({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);
    const res = await GET(makeRequest());
    expect(res.status).toBe(429);
  });

  it('returns 400 for invalid query params', async () => {
    // `limit` must be a positive integer per approvalHistoryQuerySchema.
    const res = await GET(makeRequest('?limit=not-a-number'));
    expect(res.status).toBe(400);
  });

  // ─── Filter coverage ──────────────────────────────────────────────────────

  it('filters by decision alone (approved)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution(
        [
          approvalEntry({ stepId: 'a' }),
          approvalEntry({
            stepId: 'b',
            status: 'rejected',
            output: { rejected: true, reason: 'no', actor: 'token:chat' },
          }),
        ],
        { id: 'exec-x' }
      ),
    ] as never);

    const res = await GET(makeRequest('?decision=approved'));
    const body = await parseJson<{ data: Array<{ stepId: string; decision: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].stepId).toBe('a');
  });

  it('filters by medium=admin alone', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution(
        [
          approvalEntry({ stepId: 'admin-a' }),
          approvalEntry({
            stepId: 'token-b',
            output: { approved: true, actor: 'token:chat' },
          }),
        ],
        { id: 'exec-y' }
      ),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?medium=admin'));
    const body = await parseJson<{ data: Array<{ stepId: string; medium: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].stepId).toBe('admin-a');
    expect(body.data[0].medium).toBe('admin');
  });

  it('filters by text search across workflowName, stepLabel, and approverName', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([approvalEntry({ stepId: 'a', label: 'Onboarding step' })], {
        workflow: { name: 'Audit' },
      }),
      makeExecution([approvalEntry({ stepId: 'b', label: 'Compliance' })], {
        id: 'exec-2',
        workflow: { name: 'Onboarding' },
      }),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?q=onboarding'));
    const body = await parseJson<{ data: Array<{ stepId: string }> }>(res);
    // Both rows match — first via stepLabel, second via workflowName.
    expect(body.data.map((r) => r.stepId).sort()).toEqual(['a', 'b']);
  });

  it('search filter matches approverName', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([approvalEntry()]),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice Approver', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?q=alice'));
    const body = await parseJson<{ data: Array<{ approverName: string | null }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].approverName).toBe('Alice Approver');
  });

  it('filters by dateFrom (decision after threshold)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([
        approvalEntry({
          stepId: 'old',
          startedAt: '2025-01-01T00:00:00.000Z',
          completedAt: '2025-01-01T00:00:01.000Z',
        }),
        approvalEntry({
          stepId: 'recent',
          startedAt: '2025-06-01T00:00:00.000Z',
          completedAt: '2025-06-01T00:00:01.000Z',
        }),
      ]),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?dateFrom=2025-03-01T00:00:00.000Z'));
    const body = await parseJson<{ data: Array<{ stepId: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].stepId).toBe('recent');
  });

  it('filters by dateTo (decision before threshold)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([
        approvalEntry({
          stepId: 'old',
          startedAt: '2025-01-01T00:00:00.000Z',
          completedAt: '2025-01-01T00:00:01.000Z',
        }),
        approvalEntry({
          stepId: 'recent',
          startedAt: '2025-06-01T00:00:00.000Z',
          completedAt: '2025-06-01T00:00:01.000Z',
        }),
      ]),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?dateTo=2025-03-01T00:00:00.000Z'));
    const body = await parseJson<{ data: Array<{ stepId: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].stepId).toBe('old');
  });

  it('paginates results — page 2 returns rows beyond limit', async () => {
    // Build five approval rows across one execution so we can slice.
    const trace = Array.from({ length: 5 }, (_, i) =>
      approvalEntry({
        stepId: `s${i}`,
        startedAt: `2025-01-0${i + 1}T00:00:00.000Z`,
        completedAt: `2025-01-0${i + 1}T00:00:01.000Z`,
      })
    );
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution(trace),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?page=2&limit=2'));
    const body = await parseJson<{
      data: Array<{ stepId: string }>;
      meta: { page: number; limit: number; total: number };
    }>(res);
    expect(body.data).toHaveLength(2);
    expect(body.meta.page).toBe(2);
    expect(body.meta.total).toBe(5);
  });

  // ─── Actor classification ─────────────────────────────────────────────────

  it('classifies unknown actor strings as medium=unknown', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([approvalEntry({ output: { approved: true, actor: 'system' } })]),
    ] as never);
    const res = await GET(makeRequest());
    const body = await parseJson<{ data: Array<{ medium: string }> }>(res);
    expect(body.data[0].medium).toBe('unknown');
  });

  it('falls back to medium=unknown when actor is absent', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([approvalEntry({ output: { approved: true } })]),
    ] as never);
    const res = await GET(makeRequest());
    const body = await parseJson<{ data: Array<{ medium: string }> }>(res);
    expect(body.data[0].medium).toBe('unknown');
  });

  it('classifies token:chat / token:embed / generic token:<x> distinctly', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution(
        [
          approvalEntry({
            stepId: 'chat',
            status: 'rejected',
            output: { rejected: true, reason: 'r', actor: 'token:chat' },
          }),
          approvalEntry({
            stepId: 'embed',
            output: { approved: true, actor: 'token:embed' },
          }),
          approvalEntry({
            stepId: 'ext',
            output: { approved: true, actor: 'token:abc' },
          }),
        ],
        { id: 'exec-tok' }
      ),
    ] as never);

    const res = await GET(makeRequest());
    const body = await parseJson<{ data: Array<{ stepId: string; medium: string }> }>(res);
    const byStep = Object.fromEntries(body.data.map((r) => [r.stepId, r.medium]));
    expect(byStep).toEqual({
      chat: 'token-chat',
      embed: 'token-embed',
      ext: 'token-external',
    });
  });

  // ─── Approver hydration ───────────────────────────────────────────────────

  it('hydrates approver name; falls back to email when name is null', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([approvalEntry()]),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: null, email: 'fallback@example.com' },
    ] as never);

    const res = await GET(makeRequest());
    const body = await parseJson<{ data: Array<{ approverName: string }> }>(res);
    expect(body.data[0].approverName).toBe('fallback@example.com');
  });

  it('leaves approverName null when the admin user no longer exists', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([approvalEntry()]),
    ] as never);
    // user.findMany returns empty — the approverUserId can't be hydrated.
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([] as never);

    const res = await GET(makeRequest());
    const body = await parseJson<{ data: Array<{ approverName: string | null }> }>(res);
    expect(body.data[0].approverName).toBeNull();
  });

  // ─── Trace robustness ─────────────────────────────────────────────────────

  it('skips trace entries that are not human_approval', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution([
        approvalEntry(),
        { ...approvalEntry({ stepId: 'llm' }), stepType: 'llm_call' },
      ]),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest());
    const body = await parseJson<{ data: Array<{ stepId: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].stepId).toBe('approve-step');
  });

  it('survives an execution whose trace fails schema parsing', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      // executionTrace is not even an array — schema parse fails, execution skipped.
      makeExecution(null as unknown as unknown[], { id: 'broken' }),
      makeExecution([approvalEntry()], { id: 'ok' }),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await parseJson<{ data: Array<{ executionId: string }> }>(res);
    // Only the ok execution's row surfaces.
    expect(body.data).toHaveLength(1);
    expect(body.data[0].executionId).toBe('ok');
  });

  it('returns empty paginated result when no executions match', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([] as never);
    const res = await GET(makeRequest());
    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(res);
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  // ─── CSV escaping ─────────────────────────────────────────────────────────

  it('CSV-escapes values containing commas, quotes, and newlines', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution(
        [
          approvalEntry({
            output: {
              approved: true,
              notes: 'has "quotes", commas,\nand newline',
              actor: `admin:${APPROVER_ID}`,
            },
          }),
        ],
        { workflow: { name: 'Has, comma' } }
      ),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?format=csv'));
    const text = await res.text();
    // Commas trigger double-quote wrapping; embedded quotes get doubled.
    expect(text).toContain('"Has, comma"');
    expect(text).toContain('""quotes""');
  });

  it('CSV row count is capped at MAX_CSV_ROWS', async () => {
    // Generate 5001 approval rows across one execution to exercise the cap.
    const trace = Array.from({ length: 5001 }, (_, i) =>
      approvalEntry({
        stepId: `s${i}`,
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:00:01.000Z',
      })
    );
    vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValueOnce([
      makeExecution(trace),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: APPROVER_ID, name: 'Alice', email: 'a@x.com' },
    ] as never);

    const res = await GET(makeRequest('?format=csv'));
    const text = await res.text();
    // 1 header line + 5000 data rows = 5001 total lines.
    const lineCount = text.split('\n').length;
    expect(lineCount).toBe(5001);
  });
});
