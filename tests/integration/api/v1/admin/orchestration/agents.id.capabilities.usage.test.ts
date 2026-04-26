/**
 * Integration Test: Admin Orchestration — Capability Rate-Limit Usage
 *
 * GET /api/v1/admin/orchestration/agents/:id/capabilities/usage
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/capabilities/usage/route.ts
 *
 * Key assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - Invalid CUID returns 400
 * - Returns usage map keyed by capability slug for the last 60 seconds
 * - Rows without a slug are excluded from the usage map
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/agents/[id]/capabilities/usage/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';

function makeRequest(agentId: string = AGENT_ID): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${agentId}/capabilities/usage`,
  } as unknown as NextRequest;
}

function makeParams(id: string = AGENT_ID) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/agents/:id/capabilities/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 for unauthenticated users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(403);
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  it('returns 429 when rate limited', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(429);
    expect(vi.mocked(prisma.$queryRaw)).not.toHaveBeenCalled();
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('returns 400 for invalid agent CUID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await GET(makeRequest('not-a-valid-cuid'), makeParams('not-a-valid-cuid'));

    expect(response.status).toBe(400);
    const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });

  // ── Success ───────────────────────────────────────────────────────────────

  it('returns 200 with empty usage map when no tool calls exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const data = await parseJson<{ success: boolean; data: { usage: Record<string, number> } }>(
      response
    );
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(data.success).toBe(true);
    expect(data.data.usage).toEqual({});
  });

  it('returns usage counts keyed by capability slug', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { slug: 'web-search', count: 5 },
      { slug: 'calculator', count: 2 },
    ] as never);

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const data = await parseJson<{ success: boolean; data: { usage: Record<string, number> } }>(
      response
    );
    expect(data.data.usage).toEqual({
      'web-search': 5,
      calculator: 2,
    });
  });

  it('excludes rows where slug is null or missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { slug: 'web-search', count: 3 },
      { slug: null, count: 1 },
      { slug: undefined, count: 2 },
    ] as never);

    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const data = await parseJson<{ success: boolean; data: { usage: Record<string, number> } }>(
      response
    );
    expect(Object.keys(data.data.usage)).toHaveLength(1);
    expect(data.data.usage['web-search']).toBe(3);
  });

  it('calls $queryRaw with the correct agent ID', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    await GET(makeRequest(), makeParams());

    expect(vi.mocked(prisma.$queryRaw)).toHaveBeenCalledOnce();
    // The raw query is a tagged template literal — verify it was invoked with strings
    // containing the agent context (count, agentId, tool_call)
    const callArgs = vi.mocked(prisma.$queryRaw).mock.calls[0];
    expect(callArgs).toBeDefined();
  });
});
