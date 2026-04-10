/**
 * Integration Test: Admin Orchestration — Knowledge Seed
 *
 * POST /api/v1/admin/orchestration/knowledge/seed
 *
 * @see app/api/v1/admin/orchestration/knowledge/seed/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - seedFromChunksJson is called with a path ending in lib/orchestration/seed/chunks.json
 * - Response contains { seeded: true }
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/knowledge/seed/route';
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

vi.mock('@/lib/orchestration/knowledge/seeder', () => ({
  seedFromChunksJson: vi.fn(),
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
import { seedFromChunksJson } from '@/lib/orchestration/knowledge/seeder';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    url: 'http://localhost:3000/api/v1/admin/orchestration/knowledge/seed',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/knowledge/seed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makeRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makeRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Successful seeding', () => {
    it('returns 200 with { seeded: true }', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(seedFromChunksJson).mockResolvedValue(undefined);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: { seeded: boolean } }>(response);
      expect(data.success).toBe(true);
      expect(data.data.seeded).toBe(true);
    });

    it('calls seedFromChunksJson with path ending in lib/orchestration/seed/chunks.json', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(seedFromChunksJson).mockResolvedValue(undefined);

      await POST(makeRequest());

      expect(vi.mocked(seedFromChunksJson)).toHaveBeenCalledOnce();
      const calledWith = vi.mocked(seedFromChunksJson).mock.calls[0][0];
      expect(calledWith).toMatch(/lib[/\\]orchestration[/\\]seed[/\\]chunks\.json$/);
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(seedFromChunksJson).mockResolvedValue(undefined);

      await POST(makeRequest());

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });
  });
});
