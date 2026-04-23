/**
 * Tests: MCP API Key Rotation
 *
 * POST /api/v1/admin/orchestration/mcp/keys/:id/rotate
 *
 * @see app/api/v1/admin/orchestration/mcp/keys/[id]/rotate/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpApiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/mcp/auth', () => ({
  generateApiKey: vi.fn(() => ({
    plaintext: 'smcp_newkey123456789',
    hash: 'sha256_newhash',
    prefix: 'smcp_newkey1',
  })),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { generateApiKey } from '@/lib/orchestration/mcp/auth';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { POST } from '@/app/api/v1/admin/orchestration/mcp/keys/[id]/rotate/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_ID = 'clg1234567890abcdef12345';

function makeRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/mcp/keys/${VALID_ID}/rotate`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
  );
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

const EXISTING_KEY = {
  id: VALID_ID,
  name: 'Test Key',
  keyHash: 'sha256_oldhash',
  keyPrefix: 'smcp_oldkey1',
  scopes: ['admin'],
  isActive: true,
  expiresAt: null,
  lastUsedAt: null,
  rateLimitOverride: null,
  createdAt: new Date('2026-04-01'),
  updatedAt: new Date('2026-04-01'),
};

const UPDATED_KEY = {
  id: VALID_ID,
  name: 'Test Key',
  keyPrefix: 'smcp_newkey1',
  scopes: ['admin'],
  isActive: true,
  expiresAt: null,
  lastUsedAt: null,
  rateLimitOverride: null,
  createdAt: new Date('2026-04-01'),
  updatedAt: new Date('2026-04-20'),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/mcp/keys/:id/rotate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(EXISTING_KEY as never);
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue(UPDATED_KEY as never);
  });

  // ── Auth ───────────────────────────────────────────────────────────────

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await POST(makeRequest(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(response.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await POST(makeRequest(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(response.status).toBe(403);
  });

  // ── Rate limiting ─────────────────────────────────────────────────────

  it('returns 429 when rate limit exceeded', async () => {
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);
    const response = await POST(makeRequest(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(response.status).toBe(429);
  });

  // ── Not found ─────────────────────────────────────────────────────────

  it('returns 404 when key not found', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(null);
    const response = await POST(makeRequest(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(response.status).toBe(404);
  });

  // ── Happy path ────────────────────────────────────────────────────────

  it('rotates key and returns new plaintextKey', async () => {
    const response = await POST(makeRequest(), { params: Promise.resolve({ id: VALID_ID }) });
    const body = await parseJson<{ success: boolean; data: Record<string, unknown> }>(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.plaintextKey).toBe('smcp_newkey123456789');
    expect(body.data.keyPrefix).toBe('smcp_newkey1');
  });

  it('calls generateApiKey to create new key material', async () => {
    await POST(makeRequest(), { params: Promise.resolve({ id: VALID_ID }) });
    expect(generateApiKey).toHaveBeenCalledTimes(1);
  });

  it('updates keyHash and keyPrefix in database', async () => {
    await POST(makeRequest(), { params: Promise.resolve({ id: VALID_ID }) });

    expect(prisma.mcpApiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VALID_ID },
        data: expect.objectContaining({
          keyHash: 'sha256_newhash',
          keyPrefix: 'smcp_newkey1',
        }),
      })
    );
  });

  it('does not include keyHash in response', async () => {
    const response = await POST(makeRequest(), { params: Promise.resolve({ id: VALID_ID }) });
    const body = await parseJson<{ data: Record<string, unknown> }>(response);

    expect(body.data).not.toHaveProperty('keyHash');
  });

  it('updates expiresAt when provided in body', async () => {
    const expiry = '2027-01-01T00:00:00.000Z';
    const response = await POST(makeRequest({ expiresAt: expiry }), {
      params: Promise.resolve({ id: VALID_ID }),
    });

    expect(response.status).toBe(200);
    expect(prisma.mcpApiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expiresAt: new Date(expiry),
        }),
      })
    );
  });

  it('does not change expiresAt when not provided in body', async () => {
    await POST(makeRequest({}), { params: Promise.resolve({ id: VALID_ID }) });

    const updateCall = vi.mocked(prisma.mcpApiKey.update).mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('expiresAt');
  });

  it('allows setting expiresAt to null (no expiry)', async () => {
    await POST(makeRequest({ expiresAt: null }), { params: Promise.resolve({ id: VALID_ID }) });

    expect(prisma.mcpApiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expiresAt: null,
        }),
      })
    );
  });
});
