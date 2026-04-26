/**
 * Tests: MCP Sessions Endpoint
 *
 * GET /api/v1/admin/orchestration/mcp/sessions — list active in-memory sessions
 *
 * Test Coverage:
 * - Authentication (401/403 guards)
 * - GET: returns list of active sessions from session manager
 * - GET: returns empty array when no sessions are active
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/sessions/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(
    () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() => Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

const mockGetActiveSessions = vi.fn();

vi.mock('@/lib/orchestration/mcp', () => ({
  getMcpSessionManager: vi.fn(() => ({
    getActiveSessions: mockGetActiveSessions,
  })),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/admin/orchestration/mcp/sessions/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-uuid-1',
    apiKeyId: 'cmjbv4i3x00003wsloputgwu1',
    initialized: true,
    createdAt: Date.now() - 60_000,
    lastActivityAt: Date.now() - 5_000,
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/mcp/sessions');
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('GET /mcp/sessions', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await GET(makeGetRequest());

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns list of active sessions', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockGetActiveSessions.mockReturnValue([makeSession(), makeSession({ id: 'session-uuid-2' })]);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[] }>(response);
    expect(body.data).toHaveLength(2);
  });

  it('returns empty array when no sessions are active', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockGetActiveSessions.mockReturnValue([]);

    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const body = await parseJson<{ data: unknown[] }>(response);
    expect(body.data).toHaveLength(0);
  });

  it('calls getActiveSessions on the session manager', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockGetActiveSessions.mockReturnValue([]);

    await GET(makeGetRequest());

    // test-review:accept no_arg_called — zero-arg side-effect trigger
    expect(mockGetActiveSessions).toHaveBeenCalled();
  });
});
