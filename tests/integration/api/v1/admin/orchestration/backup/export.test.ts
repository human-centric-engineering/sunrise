/**
 * Integration Test: Admin Orchestration — Backup Export
 *
 * POST /api/v1/admin/orchestration/backup/export
 *
 * @see app/api/v1/admin/orchestration/backup/export/route.ts
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/backup/export/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

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
import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { SHARED_SETTINGS_REFUSAL_CODE } from '@/lib/tenancy/shared-settings';
import { BACKUP_SHARED_REFUSAL } from '@/lib/orchestration/backup/scope';
import { exportOrchestrationConfig } from '@/lib/orchestration/backup/exporter';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const CUSTOMER = 'cmorg00000000000customer';
const OTHER_CUSTOMER = 'cmorg000000000000other01';

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

function makePostRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/backup/export${query}`, {
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
    env.TENANCY_MODE = 'single';
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

    it('names the install org in the filename at single, followed by the export time', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest());

      expect(response.headers.get('Content-Disposition')).toBe(
        `attachment; filename="orchestration-backup-${INSTALL_ORG_ID}-2025-01-01T00-00-00-000Z.json"`
      );
    });

    it('names the org the backup is of in the filename, not the caller’s', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({ status: 'ACTIVE' } as never);

      const response = await POST(makePostRequest(`?orgId=${OTHER_CUSTOMER}`));

      expect(response.headers.get('Content-Disposition')).toBe(
        `attachment; filename="orchestration-backup-${OTHER_CUSTOMER}-2025-01-01T00-00-00-000Z.json"`
      );
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

    it('audits the org the backup is of as the entity, not a fixed label', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest());

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: INSTALL_ORG_ID })
      );
    });
  });

  describe('Scope (§109 t-738)', () => {
    it('at single, resolves to the install org with the shared part included when nothing is asked', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest());

      expect(vi.mocked(exportOrchestrationConfig)).toHaveBeenCalledWith({
        orgId: INSTALL_ORG_ID,
        includeShared: true,
      });
    });

    it('at single, ?shared=false drops the shared part from the scope', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest('?shared=false'));

      expect(vi.mocked(exportOrchestrationConfig)).toHaveBeenCalledWith({
        orgId: INSTALL_ORG_ID,
        includeShared: false,
      });
    });

    it('returns 400 VALIDATION_ERROR for shared=yes and does not export', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest('?shared=yes'));

      expect(response.status).toBe(400);
      const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
      expect(data).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
      expect(vi.mocked(exportOrchestrationConfig)).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR for a malformed orgId and does not export', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest('?orgId=not%20an%20org!'));

      expect(response.status).toBe(400);
      expect(vi.mocked(exportOrchestrationConfig)).not.toHaveBeenCalled();
    });

    it('at multi, a customer org gets its own part only: the shared part is left out by default', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(CUSTOMER);

      const response = await POST(makePostRequest());

      expect(response.status).toBe(200);
      expect(vi.mocked(exportOrchestrationConfig)).toHaveBeenCalledWith({
        orgId: CUSTOMER,
        includeShared: false,
      });
    });

    it('at multi, refuses shared=true from a customer org with the install-org reason and does not export', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(CUSTOMER);

      const response = await POST(makePostRequest('?shared=true'));

      expect(response.status).toBe(403);
      const data = await parseJson<{
        success: boolean;
        error: { message: string; details: { reason: string } };
      }>(response);
      expect(data.error.message).toBe(BACKUP_SHARED_REFUSAL);
      expect(data.error.details.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
      expect(vi.mocked(exportOrchestrationConfig)).not.toHaveBeenCalled();
      expect(vi.mocked(logAdminAction)).not.toHaveBeenCalled();
    });

    it('at multi, the install org may ask for the shared part', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);

      const response = await POST(makePostRequest('?shared=true'));

      expect(response.status).toBe(200);
      expect(vi.mocked(exportOrchestrationConfig)).toHaveBeenCalledWith({
        orgId: INSTALL_ORG_ID,
        includeShared: true,
      });
    });

    it('at multi, ?orgId names another org after the policy is asked about it', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({ status: 'ACTIVE' } as never);

      const response = await POST(makePostRequest(`?orgId=${OTHER_CUSTOMER}&shared=false`));

      expect(response.status).toBe(200);
      expect(vi.mocked(prisma.org.findUnique)).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: OTHER_CUSTOMER } })
      );
      expect(vi.mocked(exportOrchestrationConfig)).toHaveBeenCalledWith({
        orgId: OTHER_CUSTOMER,
        includeShared: false,
      });
    });

    it('at multi, refuses shared=true from a customer org naming the install org as the target', async () => {
      // The shared part follows the CALLER's org, not the one named in ?orgId=.
      env.TENANCY_MODE = 'multi';
      adminIn(CUSTOMER);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({ status: 'ACTIVE' } as never);

      const response = await POST(makePostRequest(`?orgId=${INSTALL_ORG_ID}&shared=true`));

      expect(response.status).toBe(403);
      const data = await parseJson<{ error: { details: { reason: string } } }>(response);
      expect(data.error.details.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
      expect(vi.mocked(exportOrchestrationConfig)).not.toHaveBeenCalled();
    });

    it('at multi, the install org may export the shared part with a customer org it names', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({ status: 'ACTIVE' } as never);

      const response = await POST(makePostRequest(`?orgId=${OTHER_CUSTOMER}&shared=true`));

      expect(response.status).toBe(200);
      expect(vi.mocked(exportOrchestrationConfig)).toHaveBeenCalledWith({
        orgId: OTHER_CUSTOMER,
        includeShared: true,
      });
    });

    it('at multi, still exports a suspended org it names', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      vi.mocked(prisma.org.findUnique).mockResolvedValue({ status: 'SUSPENDED' } as never);

      const response = await POST(makePostRequest(`?orgId=${OTHER_CUSTOMER}`));

      expect(response.status).toBe(200);
      expect(vi.mocked(exportOrchestrationConfig)).toHaveBeenCalledWith({
        orgId: OTHER_CUSTOMER,
        includeShared: false,
      });
    });

    it('at multi, returns 404 for an org that does not exist and does not export', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(INSTALL_ORG_ID);
      vi.mocked(prisma.org.findUnique).mockResolvedValue(null);

      const response = await POST(makePostRequest(`?orgId=${OTHER_CUSTOMER}`));

      expect(response.status).toBe(404);
      expect(vi.mocked(exportOrchestrationConfig)).not.toHaveBeenCalled();
    });
  });

  describe('Audit metadata (§109 t-738)', () => {
    it('records the org and whether the shared part was included, alongside the counts', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      await POST(makePostRequest('?shared=false'));

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            orgId: INSTALL_ORG_ID,
            includesShared: false,
            agents: 1,
            hasSettings: false,
          }),
        })
      );
    });

    it('records the customer org at multi, as both the entity and the metadata org', async () => {
      env.TENANCY_MODE = 'multi';
      adminIn(CUSTOMER);

      await POST(makePostRequest());

      expect(vi.mocked(logAdminAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: CUSTOMER,
          metadata: expect.objectContaining({ orgId: CUSTOMER, includesShared: false }),
        })
      );
    });
  });
});
