/**
 * Unit test for GET /api/v1/admin/orchestration/executions/:id/report.md.
 *
 * The endpoint reads the persisted execution + trace and emits a
 * deterministic Markdown render. The renderer has its own tests
 * (tests/unit/lib/orchestration/trace/render-markdown.test.ts) so
 * these focus on the route glue: auth, id validation, ownership scoping,
 * trace parsing, and the response headers (content-type, attachment).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { GET } from '@/app/api/v1/admin/orchestration/executions/[id]/report.md/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Helpers ────────────────────────────────────────────────────────────────

const EXEC_ID = 'cmjbv4i3x00003wsloputgwu9';

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXEC_ID}/report.md`,
    { method: 'GET' }
  );
}

function makeContext(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: EXEC_ID }) };
}

function happyExecution(): Record<string, unknown> {
  return {
    id: EXEC_ID,
    userId: 'cmjbv4i3x00003wsloputgwul',
    workflowId: 'wf-1',
    status: 'completed',
    inputData: { foo: 'bar' },
    outputData: { result: 'ok' },
    errorMessage: null,
    totalTokensUsed: 1500,
    totalCostUsd: 0.023,
    startedAt: new Date('2026-05-17T10:00:00.000Z'),
    completedAt: new Date('2026-05-17T10:00:05.000Z'),
    createdAt: new Date('2026-05-17T09:59:00.000Z'),
    supervisorVerdict: null,
    supervisorScore: null,
    supervisorReport: null,
    supervisorReviewedAt: null,
    executionTrace: [
      {
        stepId: 's1',
        stepType: 'llm_call',
        label: 'first step',
        status: 'completed',
        output: 'first output',
        startedAt: '2026-05-17T10:00:00.000Z',
        completedAt: '2026-05-17T10:00:01.000Z',
        durationMs: 1000,
        tokensUsed: 200,
        costUsd: 0.001,
      },
    ],
    workflow: { name: 'Test workflow' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/executions/:id/report.md', () => {
  it('rejects unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(401);
  });

  it('returns 400 when the id is not a valid CUID', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/v1/admin/orchestration/executions/not-a-cuid/report.md',
      { method: 'GET' }
    );
    const ctx = { params: Promise.resolve({ id: 'not-a-cuid' }) };
    const res = await GET(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the execution does not exist', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(null);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(404);
  });

  it('returns 404 when the execution belongs to another user', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...happyExecution(),
      userId: 'someone-else',
    } as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(404);
  });

  it('returns 200 with the rendered Markdown on happy path', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(happyExecution() as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('# Execution report');
    expect(body).toContain(EXEC_ID);
    expect(body).toContain('Test workflow');
    expect(body).toContain('### 1. first step');
  });

  it('shortens webhook URLs in the rendered steps, input data and output data (t-777)', async () => {
    const SECRET = 'Xk9fQ2mZp4LrT7vB1nWc8sYd';
    const SLACK = `https://hooks.slack.com/services/T0000/B0000/${SECRET}?token=qs-secret`;
    const notifyEntry = {
      stepId: 'notify',
      stepType: 'send_notification',
      label: 'Notify',
      status: 'completed',
      input: { channel: 'webhook', webhookUrl: SLACK, bodyTemplate: 'Done' },
      output: { sent: true, channel: 'webhook', url: SLACK },
      tokensUsed: 0,
      costUsd: 0,
      startedAt: '2026-05-17T10:00:00.000Z',
      completedAt: '2026-05-17T10:00:01.000Z',
      durationMs: 1000,
    };
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...happyExecution(),
      inputData: { callbackUrl: SLACK },
      outputData: { notify: { url: SLACK } },
      executionTrace: [notifyEntry],
    } as never);

    const res = await GET(makeRequest(), makeContext());
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('https://hooks.slack.com/services/T0000/B0000/[param]');
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('qs-secret');
  });

  it('sets Content-Type to text/markdown and Content-Disposition to attachment', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(happyExecution() as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.headers.get('content-type')).toMatch(/^text\/markdown/);
    const disposition = res.headers.get('content-disposition');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain(`execution-${EXEC_ID}.md`);
  });

  it('includes the supervisor block when supervisorReport is present on the row', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...happyExecution(),
      supervisorVerdict: 'concerns',
      supervisorScore: 0.6,
      supervisorReviewedAt: new Date('2026-05-17T10:00:10.000Z'),
      supervisorReport: {
        verdict: 'concerns',
        score: 0.6,
        summary: 'Some issues found.',
        strengths: [],
        weaknesses: [
          {
            severity: 'medium',
            claim: 'something off',
            evidenceStepId: 's1',
            evidenceQuote: 'output',
            recommendation: 'investigate',
          },
        ],
        anomalies: [],
        unverifiedAreas: [],
        confidence: 'medium',
      },
    } as never);
    const res = await GET(makeRequest(), makeContext());
    const body = await res.text();
    expect(body).toContain('Neutral supervisor assessment');
    expect(body).toContain('Some issues found.');
    expect(body).toContain('something off');
  });

  it('returns Cache-Control: no-store so downloads are always fresh', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue(happyExecution() as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 409 when the execution is still running (non-terminal)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...happyExecution(),
      status: 'running',
    } as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('terminal');
  });

  it('returns 409 when the execution is paused_for_approval', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...happyExecution(),
      status: 'paused_for_approval',
    } as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(409);
  });

  it('returns 200 on a failed execution (failed is terminal)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...happyExecution(),
      status: 'failed',
      errorMessage: 'something broke',
    } as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('something broke');
  });

  it('returns 200 on a cancelled execution (cancelled is terminal)', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...happyExecution(),
      status: 'cancelled',
    } as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(200);
  });

  it('handles executions whose startedAt/completedAt are null (cancelled before start)', async () => {
    // Exercises the optional-chain `.toISOString() ?? null` branches in
    // the renderInfo builder. A workflow that was cancelled immediately
    // (terminal but never started) has these unset.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      ...happyExecution(),
      status: 'cancelled',
      startedAt: null,
      completedAt: null,
    } as never);
    const res = await GET(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const body = await res.text();
    // The renderer surfaces em-dash for missing timestamps; the route
    // didn't crash on the null toISOString() chain.
    expect(body).toContain('| Started | — |');
    expect(body).toContain('| Completed | — |');
  });
});
