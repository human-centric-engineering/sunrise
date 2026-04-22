/**
 * Unit Test: API Key Management Endpoints
 *
 * Covers:
 * - GET /user/api-keys — list keys
 * - POST /user/api-keys — create key
 * - DELETE /user/api-keys/:keyId — revoke key
 * - Auth + rate limiting
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiApiKey: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  apiLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>();
  return {
    ...actual,
    generateApiKey: vi.fn(
      () => 'sk_test1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    ),
    hashApiKey: vi.fn(() => 'abc123hash'),
    keyPrefix: vi.fn(() => 'sk_test1'),
  };
});

// ─── Imports ────────────────────────────────────────────────────────────────

import { GET, POST } from '@/app/api/v1/user/api-keys/route';
import { DELETE } from '@/app/api/v1/user/api-keys/[keyId]/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { apiLimiter } from '@/lib/security/rate-limit';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

const KEY_ID = 'cmjbv4i3x00003wsloputgwul';
const USER_ID = 'cmjbv4i3x00005wsloputgwun';

function makeGetRequest(): NextRequest {
  return new Request('http://localhost/test', {
    method: 'GET',
  }) as unknown as NextRequest;
}

function makePostRequest(body: unknown): NextRequest {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeDeleteRequest(): NextRequest {
  return new Request('http://localhost/test', {
    method: 'DELETE',
  }) as unknown as NextRequest;
}

function makeKeyParams(keyId = KEY_ID) {
  return { params: Promise.resolve({ keyId }) };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('API Key Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(apiLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── GET — List keys ────────────────────────────────────────────────────

  describe('GET /user/api-keys', () => {
    it('returns the current user keys', async () => {
      vi.mocked(prisma.aiApiKey.findMany).mockResolvedValue([
        {
          id: KEY_ID,
          name: 'My CI Key',
          keyPrefix: 'sk_abc1',
          scopes: ['chat'],
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date(),
        },
      ] as never);

      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.keys).toHaveLength(1);
      expect(json.data.keys[0].name).toBe('My CI Key');
    });

    it('returns empty list when user has no keys', async () => {
      // Arrange: no keys
      vi.mocked(prisma.aiApiKey.findMany).mockResolvedValue([]);

      // Act
      const res = await GET(makeGetRequest());
      const json = JSON.parse(await res.text());

      // Assert
      expect(res.status).toBe(200);
      expect(json.data.keys).toHaveLength(0);
    });

    it('rejects unauthenticated requests', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const res = await GET(makeGetRequest());

      expect(res.status).toBe(401);
    });

    it('returns 429 when rate limited on GET', async () => {
      // Arrange: rate limit exceeded
      vi.mocked(apiLimiter.check).mockReturnValue({
        success: false,
        limit: 20,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      const res = await GET(makeGetRequest());

      expect(res.status).toBe(429);
      expect(prisma.aiApiKey.findMany).not.toHaveBeenCalled();
    });
  });

  // ── POST — Create key ──────────────────────────────────────────────────

  describe('POST /user/api-keys', () => {
    it('creates a new API key and returns raw key', async () => {
      vi.mocked(prisma.aiApiKey.create).mockResolvedValue({
        id: KEY_ID,
        name: 'My Key',
        keyPrefix: 'sk_test1',
        scopes: ['chat'],
        expiresAt: null,
        createdAt: new Date(),
      } as never);

      const res = await POST(makePostRequest({ name: 'My Key', scopes: ['chat'] }));
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(201);
      expect(json.data.key.name).toBe('My Key');
      expect(json.data.key.rawKey).toMatch(/^sk_/);
    });

    it('rejects empty name', async () => {
      const res = await POST(makePostRequest({ name: '', scopes: ['chat'] }));

      expect(res.status).toBe(400);
    });

    it('rejects invalid scopes', async () => {
      const res = await POST(makePostRequest({ name: 'Key', scopes: ['invalid'] }));

      expect(res.status).toBe(400);
    });

    it('rejects admin scope for non-admin users', async () => {
      // Default mock user has role 'USER'
      const res = await POST(makePostRequest({ name: 'Admin Key', scopes: ['admin'] }));

      expect(res.status).toBe(403);
    });

    it('allows admin scope for admin users', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('ADMIN'));
      vi.mocked(prisma.aiApiKey.create).mockResolvedValue({
        id: KEY_ID,
        name: 'Admin Key',
        keyPrefix: 'sk_test1',
        scopes: ['admin'],
        expiresAt: null,
        createdAt: new Date(),
      } as never);

      const res = await POST(makePostRequest({ name: 'Admin Key', scopes: ['admin'] }));

      expect(res.status).toBe(201);
    });

    it('creates a key with an expiry date when expiresAt is provided', async () => {
      // Arrange: key with future expiry
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      vi.mocked(prisma.aiApiKey.create).mockResolvedValue({
        id: KEY_ID,
        name: 'Expiring Key',
        keyPrefix: 'sk_test1',
        scopes: ['chat'],
        expiresAt: new Date(expiresAt),
        createdAt: new Date(),
      } as never);

      // Act
      const res = await POST(
        makePostRequest({ name: 'Expiring Key', scopes: ['chat'], expiresAt })
      );
      const json = JSON.parse(await res.text());

      // Assert: expiry passed to Prisma
      expect(res.status).toBe(201);
      expect(prisma.aiApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ expiresAt: new Date(expiresAt) }),
        })
      );
      expect(json.data.key.rawKey).toMatch(/^sk_/);
    });

    it('creates a key without expiry when expiresAt is omitted', async () => {
      // Arrange
      vi.mocked(prisma.aiApiKey.create).mockResolvedValue({
        id: KEY_ID,
        name: 'Permanent Key',
        keyPrefix: 'sk_test1',
        scopes: ['chat'],
        expiresAt: null,
        createdAt: new Date(),
      } as never);

      // Act
      await POST(makePostRequest({ name: 'Permanent Key', scopes: ['chat'] }));

      // Assert: expiresAt is null
      expect(prisma.aiApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ expiresAt: null }),
        })
      );
    });

    it('returns 429 when rate limited on POST', async () => {
      // Arrange: rate limit exceeded
      vi.mocked(apiLimiter.check).mockReturnValue({
        success: false,
        limit: 20,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      const res = await POST(makePostRequest({ name: 'My Key', scopes: ['chat'] }));

      expect(res.status).toBe(429);
      expect(prisma.aiApiKey.create).not.toHaveBeenCalled();
    });
  });

  // ── DELETE — Revoke key ────────────────────────────────────────────────

  describe('DELETE /user/api-keys/:keyId', () => {
    it('revokes an active key', async () => {
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
        id: KEY_ID,
        userId: USER_ID,
        revokedAt: null,
      } as never);
      vi.mocked(prisma.aiApiKey.update).mockResolvedValue({} as never);

      const res = await DELETE(makeDeleteRequest(), makeKeyParams());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.message).toBe('API key revoked');
    });

    it('returns success for already-revoked key', async () => {
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue({
        id: KEY_ID,
        userId: USER_ID,
        revokedAt: new Date(),
      } as never);

      const res = await DELETE(makeDeleteRequest(), makeKeyParams());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.message).toBe('API key already revoked');
      expect(prisma.aiApiKey.update).not.toHaveBeenCalled();
    });

    it('returns 404 for unknown key', async () => {
      vi.mocked(prisma.aiApiKey.findFirst).mockResolvedValue(null);

      const res = await DELETE(makeDeleteRequest(), makeKeyParams());

      expect(res.status).toBe(404);
    });

    it('returns 429 when rate limited', async () => {
      vi.mocked(apiLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      const res = await DELETE(makeDeleteRequest(), makeKeyParams());

      expect(res.status).toBe(429);
    });
  });
});
