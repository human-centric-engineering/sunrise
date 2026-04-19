/**
 * Tests: Event Hook CRUD Endpoints
 *
 * GET  /api/v1/admin/orchestration/hooks
 * POST /api/v1/admin/orchestration/hooks
 * GET    /api/v1/admin/orchestration/hooks/:id
 * PATCH  /api/v1/admin/orchestration/hooks/:id
 * DELETE /api/v1/admin/orchestration/hooks/:id
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEventHook: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  invalidateHookCache: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET as ListHooks, POST as CreateHook } from '@/app/api/v1/admin/orchestration/hooks/route';
import {
  GET as GetHook,
  PATCH as UpdateHook,
  DELETE as DeleteHook,
} from '@/app/api/v1/admin/orchestration/hooks/[id]/route';

// ─── Fixtures ───────────────────────────────────────────────────────────

const HOOK_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeHook(overrides: Record<string, unknown> = {}) {
  return {
    id: HOOK_ID,
    name: 'Test Hook',
    eventType: 'conversation.started',
    action: { type: 'webhook', url: 'https://example.com/hook' },
    filter: null,
    isEnabled: true,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function makeListRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/hooks');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeCreateRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/hooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/hooks/${HOOK_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDetailRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/hooks/${HOOK_ID}`);
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/hooks/${HOOK_ID}`, {
    method: 'DELETE',
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /hooks', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await ListHooks(makeListRequest());
    expect(response.status).toBe(401);
  });

  it('returns paginated hooks', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([makeHook()] as never);
    vi.mocked(prisma.aiEventHook.count).mockResolvedValue(1);

    const response = await ListHooks(makeListRequest());
    expect(response.status).toBe(200);

    const body = await parseJson<{ data: unknown[]; meta: { total: number } }>(response);
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
  });

  it('filters by eventType', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiEventHook.count).mockResolvedValue(0);

    await ListHooks(makeListRequest({ eventType: 'workflow.completed' }));

    expect(prisma.aiEventHook.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventType: 'workflow.completed' },
      })
    );
  });
});

describe('POST /hooks', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await CreateHook(
      makeCreateRequest({
        name: 'Test',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com' },
      })
    );
    expect(response.status).toBe(401);
  });

  it('creates a webhook hook', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.create).mockResolvedValue(makeHook() as never);

    const response = await CreateHook(
      makeCreateRequest({
        name: 'Webhook Hook',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/hook' },
      })
    );

    expect(response.status).toBe(201);
    expect(prisma.aiEventHook.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Webhook Hook',
          eventType: 'conversation.started',
          action: { type: 'webhook', url: 'https://example.com/hook' },
        }),
      })
    );
  });

  it('creates an internal hook', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.create).mockResolvedValue(
      makeHook({ action: { type: 'internal', handler: 'logToAnalytics' } }) as never
    );

    const response = await CreateHook(
      makeCreateRequest({
        name: 'Internal Hook',
        eventType: 'workflow.completed',
        action: { type: 'internal', handler: 'logToAnalytics' },
      })
    );

    expect(response.status).toBe(201);
  });

  it('rejects invalid event type', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await CreateHook(
      makeCreateRequest({
        name: 'Bad Hook',
        eventType: 'invalid.event',
        action: { type: 'webhook', url: 'https://example.com' },
      })
    );

    expect(response.status).toBe(400);
  });

  it('rejects invalid webhook URL', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await CreateHook(
      makeCreateRequest({
        name: 'Bad URL',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'not-a-url' },
      })
    );

    expect(response.status).toBe(400);
  });
});

describe('GET /hooks/:id', () => {
  it('returns 404 when hook not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);

    const response = await GetHook(makeDetailRequest(), makeParams(HOOK_ID));
    expect(response.status).toBe(404);
  });

  it('returns hook details', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);

    const response = await GetHook(makeDetailRequest(), makeParams(HOOK_ID));
    expect(response.status).toBe(200);

    const body = await parseJson<{ data: { id: string } }>(response);
    expect(body.data.id).toBe(HOOK_ID);
  });
});

describe('PATCH /hooks/:id', () => {
  it('updates hook fields', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.update).mockResolvedValue(makeHook({ name: 'Updated' }) as never);

    const response = await UpdateHook(
      makePatchRequest({ name: 'Updated', isEnabled: false }),
      makeParams(HOOK_ID)
    );

    expect(response.status).toBe(200);
    expect(prisma.aiEventHook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'Updated', isEnabled: false }),
      })
    );
  });
});

describe('DELETE /hooks/:id', () => {
  it('deletes a hook', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(makeHook() as never);
    vi.mocked(prisma.aiEventHook.delete).mockResolvedValue(makeHook() as never);

    const response = await DeleteHook(makeDeleteRequest(), makeParams(HOOK_ID));
    expect(response.status).toBe(200);

    const body = await parseJson<{ data: { deleted: boolean } }>(response);
    expect(body.data.deleted).toBe(true);
  });

  it('returns 404 when hook not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiEventHook.findUnique).mockResolvedValue(null);

    const response = await DeleteHook(makeDeleteRequest(), makeParams(HOOK_ID));
    expect(response.status).toBe(404);
  });
});
