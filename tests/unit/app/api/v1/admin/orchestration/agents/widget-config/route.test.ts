/**
 * Tests: Admin Orchestration — Agent Widget Config (read + update)
 *
 * GET   /api/v1/admin/orchestration/agents/:id/widget-config
 * PATCH /api/v1/admin/orchestration/agents/:id/widget-config
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(
    () =>
      new Response(JSON.stringify({ success: false, error: { code: 'RATE_LIMITED' } }), {
        status: 429,
      })
  ),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { adminLimiter } from '@/lib/security/rate-limit';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';
import { GET, PATCH } from '@/app/api/v1/admin/orchestration/agents/[id]/widget-config/route';
import { DEFAULT_WIDGET_CONFIG } from '@/lib/validations/orchestration';

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/widget-config`
  );
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/widget-config`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function makeParams(id = AGENT_ID) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
    id: AGENT_ID,
    name: 'Council Planning',
    widgetConfig: null,
  } as never);
  vi.mocked(prisma.aiAgent.update).mockResolvedValue({
    id: AGENT_ID,
    widgetConfig: null,
  } as never);
});

describe('GET /agents/:id/widget-config', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await GET(makeGetRequest(), makeParams());
    expect(response.status).toBe(401);
  });

  it('returns 400 for invalid agent id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await GET(makeGetRequest(), makeParams('not-a-cuid'));
    expect(response.status).toBe(400);
  });

  it('returns 404 when agent not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
    const response = await GET(makeGetRequest(), makeParams());
    expect(response.status).toBe(404);
  });

  it('returns DEFAULT_WIDGET_CONFIG when widgetConfig is null', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await GET(makeGetRequest(), makeParams());
    expect(response.status).toBe(200);
    const body = await parseJson<{ data: { config: Record<string, unknown> } }>(response);
    expect(body.data.config).toEqual(DEFAULT_WIDGET_CONFIG);
  });

  it('merges stored partial config over defaults', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: AGENT_ID,
      widgetConfig: { primaryColor: '#16a34a', headerTitle: 'Council' },
    } as never);
    const response = await GET(makeGetRequest(), makeParams());
    const body = await parseJson<{ data: { config: Record<string, unknown> } }>(response);
    expect(body.data.config.primaryColor).toBe('#16a34a');
    expect(body.data.config.headerTitle).toBe('Council');
  });

  it('returns 429 when rate-limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValueOnce({ success: false } as never);
    const response = await GET(makeGetRequest(), makeParams());
    expect(response.status).toBe(429);
  });
});

describe('PATCH /agents/:id/widget-config', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await PATCH(makePatchRequest({ primaryColor: '#16a34a' }), makeParams());
    expect(response.status).toBe(401);
  });

  it('returns 400 when body is empty', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await PATCH(makePatchRequest({}), makeParams());
    expect(response.status).toBe(400);
  });

  it('returns 400 when body has only invalid fields', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await PATCH(makePatchRequest({ primaryColor: 'not-a-colour' }), makeParams());
    expect(response.status).toBe(400);
  });

  it('returns 404 when agent does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
    const response = await PATCH(makePatchRequest({ primaryColor: '#16a34a' }), makeParams());
    expect(response.status).toBe(404);
  });

  it('persists the merged widgetConfig and writes an audit row', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      id: AGENT_ID,
      name: 'Council',
      widgetConfig: { headerTitle: 'Old' },
    } as never);
    vi.mocked(prisma.aiAgent.update).mockResolvedValue({
      id: AGENT_ID,
      widgetConfig: { headerTitle: 'New', primaryColor: '#16a34a' },
    } as never);

    const response = await PATCH(
      makePatchRequest({ primaryColor: '#16a34a', headerTitle: 'New' }),
      makeParams()
    );
    expect(response.status).toBe(200);

    expect(vi.mocked(prisma.aiAgent.update)).toHaveBeenCalledWith({
      where: { id: AGENT_ID },
      data: {
        widgetConfig: expect.objectContaining({ primaryColor: '#16a34a', headerTitle: 'New' }),
      },
      select: { id: true, widgetConfig: true },
    });

    expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.widget_config.update',
        entityType: 'agent',
        entityId: AGENT_ID,
        changes: expect.objectContaining({
          primaryColor: { from: DEFAULT_WIDGET_CONFIG.primaryColor, to: '#16a34a' },
          headerTitle: { from: 'Old', to: 'New' },
        }),
      })
    );
  });

  it('returns the resolved config (defaults filled in) after update', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.update).mockResolvedValue({
      id: AGENT_ID,
      widgetConfig: { primaryColor: '#16a34a' },
    } as never);
    const response = await PATCH(makePatchRequest({ primaryColor: '#16a34a' }), makeParams());
    const body = await parseJson<{ data: { config: Record<string, unknown> } }>(response);
    expect(body.data.config.primaryColor).toBe('#16a34a');
    expect(body.data.config.sendLabel).toBe(DEFAULT_WIDGET_CONFIG.sendLabel);
  });

  it('returns 400 for invalid agent id on PATCH', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const response = await PATCH(
      makePatchRequest({ primaryColor: '#16a34a' }),
      makeParams('not-a-cuid')
    );
    expect(response.status).toBe(400);
  });

  it('returns 429 when rate-limited on PATCH', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValueOnce({ success: false } as never);
    const response = await PATCH(makePatchRequest({ primaryColor: '#16a34a' }), makeParams());
    expect(response.status).toBe(429);
  });
});
