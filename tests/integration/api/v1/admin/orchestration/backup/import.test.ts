/**
 * Integration Test: Admin Orchestration — Backup Import
 *
 * POST /api/v1/admin/orchestration/backup/import
 *
 * @see app/api/v1/admin/orchestration/backup/import/route.ts
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/backup/import/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { ZodError, ZodIssueCode } from 'zod';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    org: { findUnique: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

// Only the import itself is stubbed; the conflict predicates are the real ones,
// since the route's mapping of a thrown error depends on them.
vi.mock('@/lib/orchestration/backup/importer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/backup/importer')>()),
  importOrchestrationConfig: vi.fn(),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { SHARED_SETTINGS_REFUSAL_CODE } from '@/lib/tenancy/shared-settings';
import { BACKUP_SHARED_REFUSAL } from '@/lib/orchestration/backup/scope';
import { importOrchestrationConfig } from '@/lib/orchestration/backup/importer';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { uniqueViolationError } from '@/tests/helpers/prisma-errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const CUSTOMER = 'cmorg00000000000customer';
const OTHER_CUSTOMER = 'cmorg000000000000other01';
const IMPORT_URL = 'http://localhost:3000/api/v1/admin/orchestration/backup/import';

/** A platform admin whose session is switched into `orgId` (the guard reads `activeOrgId`). */
function adminIn(orgId: string) {
  const admin = mockAdminUser();
  vi.mocked(auth.api.getSession).mockResolvedValue({
    ...admin,
    session: { ...admin.session, activeOrgId: orgId },
  });
  // The guard verifies the switch: the admin is a member of the org named.
  vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({
    role: ORG_OWNER_ROLE,
    org: { status: 'ACTIVE' },
  } as never);
}

const originalMode = env.TENANCY_MODE;
afterAll(() => {
  env.TENANCY_MODE = originalMode;
});

function makeImportResult() {
  return {
    agents: { created: 1, updated: 1 },
    capabilities: { created: 1, updated: 0 },
    workflows: { created: 1, updated: 0 },
    webhooks: { created: 0, skipped: 0 },
    knowledgeTags: { created: 0, updated: 0 },
    settingsUpdated: true,
    sharedSkipped: false,
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

function makePostRequest(body: unknown, query = ''): NextRequest {
  return {
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: `${IMPORT_URL}${query}`,
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
    env.TENANCY_MODE = 'single';
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

  describe('Non-ZodError rethrow', () => {
    it('does not return 400 VALIDATION_ERROR and does not audit when importOrchestrationConfig rejects with a plain Error', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(importOrchestrationConfig).mockRejectedValue(new Error('database connection lost'));

      let status: number | undefined;
      try {
        const res = await POST(makePostRequest(makeValidPayload()));
        status = res.status;
      } catch {
        status = undefined;
      }

      // Load-bearing assertion: a regression that catches all errors as ZodErrors would
      // return 400 VALIDATION_ERROR. The rethrow must NOT produce a 400.
      expect(status).not.toBe(400);
      // The rethrow fires before the success audit — logAdminAction must not have been called.
      expect(vi.mocked(logAdminAction)).not.toHaveBeenCalled();
    });

    it('returns a retryable 409 when a concurrent write collides on a unique key', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(importOrchestrationConfig).mockRejectedValue(
        uniqueViolationError({
          index: 'ai_agent_version_agentId_version_key',
          modelName: 'AiAgentVersion',
        })
      );

      const res = await POST(makePostRequest(makeValidPayload()));

      // Most often an agent edit taking the version number the restore was
      // about to write; the transaction rolled back, so a retry is safe.
      expect(res.status).toBe(409);
      expect(vi.mocked(logAdminAction)).not.toHaveBeenCalled();
    });

    it('returns the retry 409 when another org took a workflow slug the import planned', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(importOrchestrationConfig).mockRejectedValue(
        uniqueViolationError({ index: 'ai_workflow_slug_key', modelName: 'AiWorkflow' })
      );

      const res = await POST(makePostRequest(makeValidPayload()));
      const body = await parseJson<{
        success: boolean;
        error: { code: string; message: string };
      }>(res);

      expect(res.status).toBe(409);
      expect(body.error.message).toBe(
        'Backup import conflicted with a concurrent change. Please retry.'
      );
      expect(vi.mocked(logAdminAction)).not.toHaveBeenCalled();
    });

    it('does not map a unique violation on another model to the retry 409', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(importOrchestrationConfig).mockRejectedValue(
        uniqueViolationError({ index: 'ai_capability_slug_key', modelName: 'AiCapability' })
      );

      const res = await POST(makePostRequest(makeValidPayload())).catch(() => null);
      const body = res ? await parseJson<{ error?: { message?: string } }>(res) : null;

      expect(body?.error?.message).not.toBe(
        'Backup import conflicted with a concurrent change. Please retry.'
      );
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

      expect(vi.mocked(importOrchestrationConfig)).toHaveBeenCalledWith(payload, ADMIN_ID, {
        orgId: INSTALL_ORG_ID,
        includeShared: true,
      });
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

    it('audits the org the backup went into as the entity, not a fixed label', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest(makeValidPayload()));

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: INSTALL_ORG_ID })
      );
    });
  });

  describe('Scope (§109 t-738)', () => {
    it('at single, ?shared=false passes a scope without the shared part to the importer', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const payload = makeValidPayload();

      await POST(makePostRequest(payload, '?shared=false'));

      expect(vi.mocked(importOrchestrationConfig)).toHaveBeenCalledWith(payload, ADMIN_ID, {
        orgId: INSTALL_ORG_ID,
        includeShared: false,
      });
    });

    it('returns 400 VALIDATION_ERROR for shared=yes and does not import', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest(makeValidPayload(), '?shared=yes'));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
      expect(vi.mocked(importOrchestrationConfig)).not.toHaveBeenCalled();
    });

    it('at multi, a customer org is NOT refused when it does not ask for the shared part', async () => {
      // The behaviour change: the route used to declare writesSharedSettings,
      // which refused the whole import from a customer org.
      env.TENANCY_MODE = 'multi';
      adminIn(CUSTOMER);
      const payload = makeValidPayload();

      const response = await POST(makePostRequest(payload));

      expect(response.status).toBe(200);
      expect(vi.mocked(importOrchestrationConfig)).toHaveBeenCalledWith(payload, ADMIN_ID, {
        orgId: CUSTOMER,
        includeShared: false,
      });
    });

    it('at multi, a customer org is NOT refused with ?shared=false', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(CUSTOMER);

      const response = await POST(makePostRequest(makeValidPayload(), '?shared=false'));

      expect(response.status).toBe(200);
      expect(vi.mocked(importOrchestrationConfig)).toHaveBeenCalledOnce();
    });

    it('at multi, refuses shared=true from a customer org with the install-org reason, before reading the body', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(CUSTOMER);
      const json = vi.fn(() => Promise.resolve(makeValidPayload()));
      const request = {
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json,
        url: `${IMPORT_URL}?shared=true`,
      } as unknown as NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(403);
      const data = await parseJson<{
        error: { message: string; details: { reason: string } };
      }>(response);
      expect(data.error.message).toBe(BACKUP_SHARED_REFUSAL);
      expect(data.error.details.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
      expect(json).not.toHaveBeenCalled();
      expect(vi.mocked(importOrchestrationConfig)).not.toHaveBeenCalled();
      expect(vi.mocked(logAdminAction)).not.toHaveBeenCalled();
    });

    it('at multi, the install org may import the shared part', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      const payload = makeValidPayload();

      const response = await POST(makePostRequest(payload, '?shared=true'));

      expect(response.status).toBe(200);
      expect(vi.mocked(importOrchestrationConfig)).toHaveBeenCalledWith(payload, ADMIN_ID, {
        orgId: INSTALL_ORG_ID,
        includeShared: true,
      });
    });

    it('at multi, ?orgId restores into another org after the policy is asked about it', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({ status: 'ACTIVE' } as never);

      const response = await POST(
        makePostRequest(makeValidPayload(), `?orgId=${OTHER_CUSTOMER}&shared=false`)
      );

      expect(response.status).toBe(200);
      expect(vi.mocked(prisma.org.findUnique)).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: OTHER_CUSTOMER } })
      );
      expect(vi.mocked(importOrchestrationConfig)).toHaveBeenCalledWith(
        expect.anything(),
        ADMIN_ID,
        { orgId: OTHER_CUSTOMER, includeShared: false }
      );
    });

    it('at multi, refuses shared=true from a customer org naming the install org as the target', async () => {
      // The shared part follows the CALLER's org, not the one named in ?orgId=.
      env.TENANCY_MODE = 'multi';
      adminIn(CUSTOMER);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({ status: 'ACTIVE' } as never);

      const response = await POST(
        makePostRequest(makeValidPayload(), `?orgId=${INSTALL_ORG_ID}&shared=true`)
      );

      expect(response.status).toBe(403);
      const data = await parseJson<{ error: { details: { reason: string } } }>(response);
      expect(data.error.details.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
      expect(vi.mocked(importOrchestrationConfig)).not.toHaveBeenCalled();
    });

    it('at multi, the install org may import the shared part of a customer org it names', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({ status: 'ACTIVE' } as never);

      const response = await POST(
        makePostRequest(makeValidPayload(), `?orgId=${OTHER_CUSTOMER}&shared=true`)
      );

      expect(response.status).toBe(200);
      expect(vi.mocked(importOrchestrationConfig)).toHaveBeenCalledWith(
        expect.anything(),
        ADMIN_ID,
        { orgId: OTHER_CUSTOMER, includeShared: true }
      );
    });

    it('at multi, returns 409 for an import into a suspended org it names, before reading the body', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({ status: 'SUSPENDED' } as never);
      const json = vi.fn(() => Promise.resolve(makeValidPayload()));
      const request = {
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json,
        url: `${IMPORT_URL}?orgId=${OTHER_CUSTOMER}`,
      } as unknown as NextRequest;

      const response = await POST(request);

      expect(response.status).toBe(409);
      expect(json).not.toHaveBeenCalled();
      expect(vi.mocked(importOrchestrationConfig)).not.toHaveBeenCalled();
      expect(vi.mocked(logAdminAction)).not.toHaveBeenCalled();
    });

    it('at multi, returns 404 for an org that does not exist and does not import', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      vi.mocked(prisma.org.findUnique).mockResolvedValue(null);

      const response = await POST(makePostRequest(makeValidPayload(), `?orgId=${OTHER_CUSTOMER}`));

      expect(response.status).toBe(404);
      expect(vi.mocked(importOrchestrationConfig)).not.toHaveBeenCalled();
    });
  });

  describe('Audit metadata (§109 t-738)', () => {
    it('records the org, includesShared and sharedSkipped from the importer result', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(importOrchestrationConfig).mockResolvedValue({
        ...makeImportResult(),
        settingsUpdated: false,
        sharedSkipped: true,
      });

      await POST(makePostRequest(makeValidPayload(), '?shared=false'));

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            orgId: INSTALL_ORG_ID,
            includesShared: false,
            sharedSkipped: true,
            settingsUpdated: false,
            warningCount: 0,
          }),
        })
      );
    });

    it('records the customer org at multi, as both the entity and the metadata org', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(CUSTOMER);

      await POST(makePostRequest(makeValidPayload()));

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: CUSTOMER,
          metadata: expect.objectContaining({
            orgId: CUSTOMER,
            includesShared: false,
            sharedSkipped: false,
          }),
        })
      );
    });
  });
});
