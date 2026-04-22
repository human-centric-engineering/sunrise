/**
 * Integration Test: Admin Orchestration — Backup Export
 *
 * POST /api/v1/admin/orchestration/backup/export
 *
 * @see app/api/v1/admin/orchestration/backup/export/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/backup/export/route';
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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/orchestration/backup/exporter', () => ({
  exportOrchestrationConfig: vi.fn(),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import { exportOrchestrationConfig } from '@/lib/orchestration/backup/exporter';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeBackupPayload() {
  return {
    schemaVersion: 1,
    exportedAt: '2025-01-01T00:00:00.000Z',
    data: {
      agents: [{ id: 'agent-1', name: 'Test Agent' }],
      capabilities: [],
      workflows: [],
      webhooks: [],
      settings: null,
    },
  };
}

function makePostRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/backup/export', {
    method: 'POST',
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/backup/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(exportOrchestrationConfig).mockResolvedValue(makeBackupPayload() as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest());

      expect(response.status).toBe(429);
      expect(vi.mocked(exportOrchestrationConfig)).not.toHaveBeenCalled();
    });
  });

  describe('Successful export', () => {
    it('returns 200 with JSON body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{ schemaVersion: number; data: unknown }>(response);
      expect(data.schemaVersion).toBe(1);
      expect(data.data).toBeDefined();
    });

    it('sets Content-Type to application/json', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest());

      expect(response.headers.get('Content-Type')).toContain('application/json');
    });

    it('sets Content-Disposition attachment header with filename', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest());

      const disposition = response.headers.get('Content-Disposition');
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('orchestration-backup-');
      expect(disposition).toContain('.json');
    });

    it('calls exportOrchestrationConfig', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest());

      expect(vi.mocked(exportOrchestrationConfig)).toHaveBeenCalledOnce();
    });

    it('calls logAdminAction with action "backup.export"', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest());

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ADMIN_ID,
          action: 'backup.export',
          entityType: 'backup',
        })
      );
    });
  });
});
