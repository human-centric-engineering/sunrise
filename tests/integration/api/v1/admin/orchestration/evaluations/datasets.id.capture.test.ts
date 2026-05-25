/**
 * Integration test: POST /api/v1/admin/orchestration/evaluations/datasets/:id/capture
 *
 * Coverage:
 * - 401 / 403 on missing or non-admin session
 * - 400 on malformed body (missing required fields per kind)
 * - 404 when the dataset isn't owned by the caller
 * - 404 when the source message is in someone else's conversation
 *   (privacy: never let a user capture another user's traffic)
 * - 404 when the source workflow execution belongs to another user
 * - 201 happy path returns the AppendCasesResult on conversation_turn
 * - 201 happy path returns the AppendCasesResult on workflow_execution
 *
 * @see app/api/v1/admin/orchestration/evaluations/datasets/[id]/capture/route.ts
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
    aiDataset: { findFirst: vi.fn() },
    aiMessage: { findUnique: vi.fn() },
    aiWorkflowExecution: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/evaluations/datasets/capture', () => ({
  captureConversationTurnAsCase: vi.fn(),
  captureWorkflowExecutionAsCase: vi.fn(),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  captureConversationTurnAsCase,
  captureWorkflowExecutionAsCase,
} from '@/lib/orchestration/evaluations/datasets/capture';
import { POST } from '@/app/api/v1/admin/orchestration/evaluations/datasets/[id]/capture/route';

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const DATASET_ID = 'cmjbv4i3x00003wsloputgwu1';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets/${DATASET_ID}/capture`,
  } as unknown as NextRequest;
}

function ctx() {
  return { params: Promise.resolve({ id: DATASET_ID }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const SAMPLE_RESULT = {
  datasetId: DATASET_ID,
  appendedCount: 1,
  newCaseCount: 5,
  newContentHash: 'new-hash',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /evaluations/datasets/:id/capture — auth', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await POST(makeRequest({ kind: 'conversation_turn', messageId: 'm-1' }), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await POST(makeRequest({ kind: 'conversation_turn', messageId: 'm-1' }), ctx());
    expect(res.status).toBe(403);
  });
});

describe('POST /evaluations/datasets/:id/capture — validation', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('rejects missing kind with 400', async () => {
    const res = await POST(makeRequest({}), ctx());
    expect(res.status).toBe(400);
  });

  it('rejects missing messageId for conversation_turn with 400', async () => {
    const res = await POST(makeRequest({ kind: 'conversation_turn' }), ctx());
    expect(res.status).toBe(400);
  });

  it('rejects step_id selector without stepId with 400', async () => {
    const res = await POST(
      makeRequest({
        kind: 'workflow_execution',
        executionId: 'e-1',
        selector: { kind: 'step_id' },
      }),
      ctx()
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /evaluations/datasets/:id/capture — dataset ownership', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('returns 404 when the dataset is not owned by the caller', async () => {
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue(null as never);

    const res = await POST(makeRequest({ kind: 'conversation_turn', messageId: 'm-1' }), ctx());

    expect(res.status).toBe(404);
    expect(vi.mocked(captureConversationTurnAsCase)).not.toHaveBeenCalled();
  });
});

describe('POST /evaluations/datasets/:id/capture — source ownership', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: DATASET_ID } as never);
  });

  it('returns 404 when the source message belongs to another user', async () => {
    vi.mocked(prisma.aiMessage.findUnique).mockResolvedValue({
      conversation: { userId: 'someone-else' },
    } as never);

    const res = await POST(makeRequest({ kind: 'conversation_turn', messageId: 'm-1' }), ctx());

    expect(res.status).toBe(404);
    expect(vi.mocked(captureConversationTurnAsCase)).not.toHaveBeenCalled();
  });

  it('returns 404 when the source execution belongs to another user', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      userId: 'someone-else',
    } as never);

    const res = await POST(
      makeRequest({
        kind: 'workflow_execution',
        executionId: 'e-1',
        selector: { kind: 'last_step' },
      }),
      ctx()
    );

    expect(res.status).toBe(404);
    expect(vi.mocked(captureWorkflowExecutionAsCase)).not.toHaveBeenCalled();
  });
});

describe('POST /evaluations/datasets/:id/capture — happy path', () => {
  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findFirst).mockResolvedValue({ id: DATASET_ID } as never);
  });

  it('conversation_turn: returns 201 with the AppendCasesResult', async () => {
    vi.mocked(prisma.aiMessage.findUnique).mockResolvedValue({
      conversation: { userId: ADMIN_ID },
    } as never);
    vi.mocked(captureConversationTurnAsCase).mockResolvedValue(SAMPLE_RESULT);

    const res = await POST(makeRequest({ kind: 'conversation_turn', messageId: 'm-1' }), ctx());

    expect(res.status).toBe(201);
    const body = await parseJson<{ success: boolean; data: typeof SAMPLE_RESULT }>(res);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(SAMPLE_RESULT);
    expect(vi.mocked(captureConversationTurnAsCase)).toHaveBeenCalledWith({
      datasetId: DATASET_ID,
      messageId: 'm-1',
    });
  });

  it('workflow_execution: returns 201 and forwards the selector', async () => {
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      userId: ADMIN_ID,
    } as never);
    vi.mocked(captureWorkflowExecutionAsCase).mockResolvedValue(SAMPLE_RESULT);

    const res = await POST(
      makeRequest({
        kind: 'workflow_execution',
        executionId: 'e-1',
        selector: { kind: 'step_id', stepId: 'final-report' },
        edits: { expectedOutput: 'tightened' },
      }),
      ctx()
    );

    expect(res.status).toBe(201);
    expect(vi.mocked(captureWorkflowExecutionAsCase)).toHaveBeenCalledWith({
      datasetId: DATASET_ID,
      executionId: 'e-1',
      selector: { kind: 'step_id', stepId: 'final-report' },
      edits: { expectedOutput: 'tightened' },
    });
  });
});
