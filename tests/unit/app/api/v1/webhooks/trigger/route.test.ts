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
    // Settings singleton lookup for resolveMaxCostPerExecution. Default
    // null = no org-wide cap; existing assertions about uncapped
    // executions still hold.
    aiOrchestrationSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    // The org entry (§106) reads a membership only for a key bound to a
    // non-install org; the default key below carries none.
    orgMembership: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
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
import { resolveApiKey, hasScope } from '@/lib/auth/api-keys';
import { getTenantContext } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

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
  // Webhook trigger now refuses to fire when no version is published.
  publishedVersionId: 'wfv_1',
  // No per-workflow cap by default — tests assert the execution row is
  // created without budgetLimitUsd. The route still calls the resolver
  // (and the settings findUnique mock above returns null) so the
  // happy-path execution stays uncapped.
  maxCostPerExecutionUsd: null,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/webhooks/trigger/:slug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        userId: 'u1',
      }),
    });
  });

  it('creates the execution inside the key’s org scope (§106) — the install org for an unbound key', async () => {
    (prisma.aiWorkflow.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkflow);
    let scopeAtCreate: string | null | undefined;
    vi.mocked(prisma.aiWorkflowExecution.create).mockImplementation((() => {
      scopeAtCreate = getTenantContext()?.orgId;
      return Promise.resolve({ id: 'exec_1' });
    }) as never);

    const res = await POST(makeRequest({}), { params: Promise.resolve({ slug: 'my-workflow' }) });

    expect(res.status).toBe(201);
    expect(scopeAtCreate).toBe(INSTALL_ORG_ID);
    expect(getTenantContext()).toBeNull();
  });

  it('refuses a key bound to an org its owner no longer belongs to, before touching the workflow', async () => {
    vi.mocked(resolveApiKey).mockResolvedValue({
      session: { user: { id: 'u1', role: 'USER' } } as never,
      scopes: ['webhook'],
      rateLimitRpm: null,
      orgId: 'cmorg000000000000000other',
      ownerAccountType: 'HUMAN',
    });

    const res = await POST(makeRequest({}), { params: Promise.resolve({ slug: 'my-workflow' }) });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { message: 'Access denied' } });
    expect(prisma.aiWorkflow.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown workflow slug', async () => {
    (prisma.aiWorkflow.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await POST(makeRequest({}), {
      params: Promise.resolve({ slug: 'nonexistent' }),
    });

    expect(res.status).toBe(404);
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
