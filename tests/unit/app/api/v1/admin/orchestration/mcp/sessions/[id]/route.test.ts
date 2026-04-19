/**
 * Tests: MCP Session by ID Endpoint
 *
 * DELETE /api/v1/admin/orchestration/mcp/sessions/:id — force-terminate session
 *
 * Test Coverage:
 * - Authentication (401/403 guards)
 * - DELETE: terminates session and returns destroyed:true
 * - DELETE: returns 404 when session not found (destroySession returns false)
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/sessions/[id]/route.ts
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

const mockDestroySession = vi.fn();

vi.mock('@/lib/orchestration/mcp', () => ({
  getMcpSessionManager: vi.fn(() => ({
    destroySession: mockDestroySession,
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
import { DELETE } from '@/app/api/v1/admin/orchestration/mcp/sessions/[id]/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION_ID = 'a3f8e2d1-c9b4-4e5a-b6f7-1234567890ab';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDeleteRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/mcp/sessions/${SESSION_ID}`,
    { method: 'DELETE' }
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
});

describe('DELETE /mcp/sessions/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await DELETE(makeDeleteRequest(), makeParams(SESSION_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await DELETE(makeDeleteRequest(), makeParams(SESSION_ID));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await DELETE(makeDeleteRequest(), makeParams(SESSION_ID));

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns 404 when session not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockDestroySession.mockReturnValue(false);

    const response = await DELETE(makeDeleteRequest(), makeParams(SESSION_ID));

    expect(response.status).toBe(404);
  });

  it('terminates session and returns destroyed:true', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockDestroySession.mockReturnValue(true);

    const response = await DELETE(makeDeleteRequest(), makeParams(SESSION_ID));

    expect(response.status).toBe(200);
    expect(mockDestroySession).toHaveBeenCalledWith(SESSION_ID);

    const body = await parseJson<{ data: { id: string; destroyed: boolean } }>(response);
    expect(body.data.id).toBe(SESSION_ID);
    expect(body.data.destroyed).toBe(true);
  });
});
