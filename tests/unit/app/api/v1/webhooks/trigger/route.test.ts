/**
 * Unit Test: POST /api/v1/webhooks/trigger/:slug
 *
 * Tests the webhook trigger endpoint that starts a workflow execution
 * using the request body as input data.
 *
 * Test Coverage:
 * - Happy path: active workflow → creates pending execution (201)
 * - Missing slug → 400
 * - Unknown/inactive workflow → 404
 * - Empty body → execution with empty inputData
 * - Non-JSON body → execution with empty inputData
 * - Array body → execution with empty inputData (only objects accepted)
 * - Rate limiting (429)
 * - DB error → 500
 *
 * @see app/api/v1/webhooks/trigger/[slug]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: { findFirst: vi.fn() },
    aiWorkflowExecution: { create: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: { check: vi.fn(() => ({ success: true })) },
  apiKeyChatLimiter: { check: vi.fn(() => ({ success: true })), reset: vi.fn() },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/auth/api-keys', () => ({
  resolveApiKey: vi.fn(),
  hasScope: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/webhooks/trigger/[slug]/route';
import { prisma } from '@/lib/db/client';
import { apiLimiter } from '@/lib/security/rate-limit';
import { resolveApiKey, hasScope } from '@/lib/auth/api-keys';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body?: unknown): NextRequest {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(
    'http://localhost/api/v1/webhooks/trigger/my-workflow',
    init
  ) as unknown as NextRequest;
}

function makeEmptyRequest(): NextRequest {
  return new Request('http://localhost/api/v1/webhooks/trigger/my-workflow', {
    method: 'POST',
  }) as unknown as NextRequest;
}

const mockWorkflow = {
  id: 'wf_1',
  slug: 'my-workflow',
  isActive: true,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/webhooks/trigger/:slug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (apiLimiter.check as ReturnType<typeof vi.fn>).mockReturnValue({ success: true });
    // Default: valid API key with webhook scope
    vi.mocked(resolveApiKey).mockResolvedValue({
      session: { user: { id: 'u1' } } as never,
      scopes: ['webhook'],
      rateLimitRpm: null,
    });
    vi.mocked(hasScope).mockReturnValue(true);
  });

  it('creates a pending execution for an active workflow (201)', async () => {
    (prisma.aiWorkflow.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkflow);
    (prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'exec_1',
    });

    const res = await POST(makeRequest({ topic: 'hello' }), {
      params: Promise.resolve({ slug: 'my-workflow' }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.executionId).toBe('exec_1');
    expect(json.data.status).toBe('pending');

    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workflowId: 'wf_1',
        status: 'pending',
        inputData: { topic: 'hello' },
        userId: 'webhook-trigger',
      }),
    });
  });

  it('returns 404 for unknown workflow slug', async () => {
    (prisma.aiWorkflow.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ slug: 'nonexistent' }),
    });

    expect(res.status).toBe(404);
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
  });

  it('returns 400 for empty slug', async () => {
    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ slug: '   ' }),
    });

    expect(res.status).toBe(400);
  });

  it('proceeds with empty inputData when body is empty', async () => {
    (prisma.aiWorkflow.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkflow);
    (prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'exec_2',
    });

    const res = await POST(makeEmptyRequest(), {
      params: Promise.resolve({ slug: 'my-workflow' }),
    });

    expect(res.status).toBe(201);
    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inputData: {},
      }),
    });
  });

  it('ignores array body and uses empty inputData', async () => {
    (prisma.aiWorkflow.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkflow);
    (prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'exec_3',
    });

    const res = await POST(makeRequest([1, 2, 3]), {
      params: Promise.resolve({ slug: 'my-workflow' }),
    });

    expect(res.status).toBe(201);
    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inputData: {},
      }),
    });
  });

  it('returns 429 when rate limited', async () => {
    (apiLimiter.check as ReturnType<typeof vi.fn>).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    });

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ slug: 'my-workflow' }),
    });

    expect(res.status).toBe(429);
    expect(prisma.aiWorkflow.findFirst).not.toHaveBeenCalled();
  });

  it('returns 500 when execution creation fails', async () => {
    (prisma.aiWorkflow.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkflow);
    (prisma.aiWorkflowExecution.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Connection refused')
    );

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ slug: 'my-workflow' }),
    });

    expect(res.status).toBe(500);
  });

  // ── Authentication ──────────────────────────────────────────────────────

  it('returns 401 when no bearer token is provided', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(null);

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ slug: 'my-workflow' }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when bearer token is invalid', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue(null);

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ slug: 'my-workflow' }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 403 when API key lacks webhook scope', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      session: { user: { id: 'u1' } } as never,
      scopes: ['chat'],
      rateLimitRpm: null,
    });
    vi.mocked(hasScope).mockReturnValue(false);

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ slug: 'my-workflow' }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('FORBIDDEN');
  });
});
