/**
 * Integration Test: Admin Orchestration — Backup Import
 *
 * POST /api/v1/admin/orchestration/backup/import
 *
 * @see app/api/v1/admin/orchestration/backup/import/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/backup/import/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { ZodError, ZodIssueCode } from 'zod';

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

vi.mock('@/lib/orchestration/backup/importer', () => ({
  importOrchestrationConfig: vi.fn(),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import { importOrchestrationConfig } from '@/lib/orchestration/backup/importer';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

function makeImportResult() {
  return {
    agents: { created: 1, updated: 1 },
    capabilities: { created: 1, updated: 0 },
    workflows: { created: 1, updated: 0 },
    webhooks: { created: 0, skipped: 0 },
    settingsUpdated: true,
    warnings: [] as string[],
  };
}

function makeValidPayload() {
  return {
    schemaVersion: 1,
    exportedAt: '2025-01-01T00:00:00.000Z',
    data: {
      agents: [],
      capabilities: [],
      workflows: [],
      webhooks: [],
      settings: null,
    },
  };
}

function makePostRequest(body: unknown): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/backup/import',
  } as unknown as NextRequest;
}

function makeBrokenJsonRequest(): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.reject(new SyntaxError('Unexpected token')),
    url: 'http://localhost:3000/api/v1/admin/orchestration/backup/import',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/backup/import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(importOrchestrationConfig).mockResolvedValue(makeImportResult());
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(makeValidPayload()));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(makeValidPayload()));

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(makeValidPayload()));

      expect(response.status).toBe(429);
    });
  });

  describe('Validation errors', () => {
    it('returns 400 VALIDATION_ERROR when request body is not valid JSON', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeBrokenJsonRequest());

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    });

    it('returns 400 VALIDATION_ERROR when importOrchestrationConfig throws ZodError', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const zodError = new ZodError([
        {
          code: ZodIssueCode.invalid_type,
          path: ['schemaVersion'],
          message: 'Expected number, received string',
          expected: 'number',
        },
      ]);
      vi.mocked(importOrchestrationConfig).mockRejectedValue(zodError);

      const response = await POST(makePostRequest({ schemaVersion: 'bad' }));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string; details: unknown } }>(
        response
      );
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
      expect(data.error.details).toBeDefined();
    });
  });

  describe('Successful import', () => {
    it('returns 200 with import result', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(makeValidPayload()));

      expect(response.status).toBe(200);
      const data = await parseJson<{ success: boolean; data: typeof makeImportResult }>(response);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      expect(data.data).toMatchObject({
        agents: { created: 1, updated: 1 },
        settingsUpdated: true,
      });
    });

    it('calls importOrchestrationConfig with the raw body and userId', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const payload = makeValidPayload();

      await POST(makePostRequest(payload));

      expect(vi.mocked(importOrchestrationConfig)).toHaveBeenCalledWith(payload, ADMIN_ID);
    });

    it('calls logAdminAction with action "backup.import"', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest(makeValidPayload()));

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: ADMIN_ID,
          action: 'backup.import',
          entityType: 'backup',
        })
      );
    });
  });
});
