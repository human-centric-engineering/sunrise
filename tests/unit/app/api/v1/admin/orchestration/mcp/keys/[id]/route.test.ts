/**
 * Tests: MCP API Key by ID Endpoints
 *
 * PATCH  /api/v1/admin/orchestration/mcp/keys/:id — update (revoke, rename, change expiry)
 * DELETE /api/v1/admin/orchestration/mcp/keys/:id — permanently delete key
 *
 * Test Coverage:
 * - Authentication (401/403 guards)
 * - PATCH: updates key fields
 * - PATCH: returns 404 when key not found
 * - PATCH: rejects invalid id (non-CUID)
 * - PATCH: rejects empty body (at least one field required)
 * - DELETE: deletes key and returns deleted:true
 * - DELETE: returns 404 when key not found
 * - Rate limiting (429 when limit exceeded)
 *
 * @see app/api/v1/admin/orchestration/mcp/keys/[id]/route.ts
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

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpApiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
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

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { PATCH, DELETE } from '@/app/api/v1/admin/orchestration/mcp/keys/[id]/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const KEY_ID = 'cmjbv4i3x00003wsloputgwu1';
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeApiKey(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    name: 'Test Key',
    keyPrefix: 'mcp_abc',
    keyHash: 'hashed',
    scopes: ['tools:list'],
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    rateLimitOverride: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/mcp/keys/${KEY_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/mcp/keys/${KEY_ID}`, {
    method: 'DELETE',
  });
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

describe('PATCH /mcp/keys/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams(KEY_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams(KEY_ID));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams(KEY_ID));

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns 400 for invalid non-CUID id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams('not-a-cuid'));

    expect(response.status).toBe(400);
  });

  it('returns 404 when key not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(null);

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams(KEY_ID));

    expect(response.status).toBe(404);
  });

  it('returns 400 when no fields provided', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await PATCH(makePatchRequest({}), makeParams(KEY_ID));

    expect(response.status).toBe(400);
  });

  it('updates key name', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(makeApiKey() as never);
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue(
      makeApiKey({ name: 'Updated Key' }) as never
    );

    const response = await PATCH(makePatchRequest({ name: 'Updated Key' }), makeParams(KEY_ID));

    expect(response.status).toBe(200);
    expect(prisma.mcpApiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: KEY_ID },
        data: expect.objectContaining({ name: 'Updated Key' }),
      })
    );
  });

  it('revokes key by setting isActive to false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(makeApiKey() as never);
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue(makeApiKey({ isActive: false }) as never);

    const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(KEY_ID));

    expect(response.status).toBe(200);
    expect(prisma.mcpApiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false }),
      })
    );
  });

  it('returns updated key data', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(makeApiKey() as never);
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue(makeApiKey({ name: 'Updated' }) as never);

    const response = await PATCH(makePatchRequest({ name: 'Updated' }), makeParams(KEY_ID));

    const body = await parseJson<{ data: { id: string; name: string } }>(response);
    expect(body.data.id).toBe(KEY_ID);
  });
});

describe('DELETE /mcp/keys/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await DELETE(makeDeleteRequest(), makeParams(KEY_ID));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await DELETE(makeDeleteRequest(), makeParams(KEY_ID));

    expect(response.status).toBe(403);
  });

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

    const response = await DELETE(makeDeleteRequest(), makeParams(KEY_ID));

    expect(createRateLimitResponse).toHaveBeenCalled();
    expect(response.status).toBe(429);
  });

  it('returns 400 for invalid non-CUID id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await DELETE(makeDeleteRequest(), makeParams('not-a-cuid'));

    expect(response.status).toBe(400);
  });

  it('returns 404 when key not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest(), makeParams(KEY_ID));

    expect(response.status).toBe(404);
  });

  it('deletes key and returns deleted:true', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(makeApiKey() as never);
    vi.mocked(prisma.mcpApiKey.delete).mockResolvedValue(makeApiKey() as never);

    const response = await DELETE(makeDeleteRequest(), makeParams(KEY_ID));

    expect(response.status).toBe(200);
    expect(prisma.mcpApiKey.delete).toHaveBeenCalledWith({ where: { id: KEY_ID } });

    const body = await parseJson<{ data: { id: string; deleted: boolean } }>(response);
    expect(body.data.id).toBe(KEY_ID);
    expect(body.data.deleted).toBe(true);
  });
});
