/**
 * Tests: the admin pages' view of a support session (§121 t-824)
 *
 * Drives the REAL `sessionPrincipal`, entry and default policy with the reads
 * mocked at Prisma, so what is pinned is what the layout and the mixed pages
 * would actually answer:
 *
 * - inside a support session `adminPageViewerTier()` answers `org`, and
 *   `requestSupportSession()` is `active` with the grant's level and expiry;
 * - once the grant ends, the session is `ended` (the HB10 remedy), and only
 *   for an org that has granted support before;
 * - at `single`, and for an ordinary member, there is no support session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const db = vi.hoisted(() => ({
  orgMembership: { findUnique: vi.fn() },
  orgSupportGrant: { findFirst: vi.fn() },
  org: { findUnique: vi.fn() },
  aiAdminAuditLog: { findFirst: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/auth/utils', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { adminPageViewerTier, requestSupportSession } from '@/lib/auth/admin-page-viewer';
import { getServerSession } from '@/lib/auth/utils';
import { headers } from 'next/headers';

const CUSTOMER = 'cmorg00000000000customer1';
const EXPIRES = new Date('2030-01-01T00:00:00Z');

function signedIn(role: 'ADMIN' | 'USER', activeOrgId: string | null) {
  vi.mocked(getServerSession).mockResolvedValue({
    session: { activeOrgId },
    user: { id: 'user_1', role },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  vi.mocked(headers).mockResolvedValue(new Headers());
  db.orgMembership.findUnique.mockResolvedValue(null);
  db.orgSupportGrant.findFirst.mockResolvedValue(null);
  db.org.findUnique.mockResolvedValue({ name: 'Customer Ltd', supportGrants: [] });
  db.aiAdminAuditLog.findFirst.mockResolvedValue(null);
  signedIn('ADMIN', CUSTOMER);
});

describe('inside a support session', () => {
  beforeEach(() => {
    db.orgSupportGrant.findFirst.mockResolvedValue({
      id: 'grant-1',
      level: 'READ_ONLY',
      expiresAt: EXPIRES,
    });
  });

  it('a platform admin is an org viewer', async () => {
    await expect(adminPageViewerTier()).resolves.toBe('org');
  });

  it('the session is active, naming the org, the level and the expiry', async () => {
    await expect(requestSupportSession()).resolves.toEqual({
      state: 'active',
      orgId: CUSTOMER,
      orgName: 'Customer Ltd',
      level: 'READ_ONLY',
      expiresAt: EXPIRES.toISOString(),
      viaResolver: false,
    });
  });

  it('notes when the org came from a resolver header, which a switch cannot leave', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ [TENANT_HEADER_NAME]: CUSTOMER }));

    await expect(requestSupportSession()).resolves.toMatchObject({
      state: 'active',
      viaResolver: true,
    });
  });
});

describe('after the grant ends', () => {
  it('the session is ended when this admin entered the org under one of its grants', async () => {
    db.org.findUnique.mockResolvedValue({ name: 'Customer Ltd', supportGrants: [{ id: 'g' }] });
    db.aiAdminAuditLog.findFirst.mockResolvedValue({ id: 'audit-1' });

    await expect(requestSupportSession()).resolves.toEqual({
      state: 'ended',
      orgId: CUSTOMER,
      orgName: 'Customer Ltd',
    });
    // Refused entry leaves the platform admin their own role: the console
    // stays reachable so the banner's way back works.
    await expect(adminPageViewerTier()).resolves.toBe('platform');
  });

  it('asks the audit log for this admin’s support.enter on one of the org’s grants', async () => {
    db.org.findUnique.mockResolvedValue({ name: 'Customer Ltd', supportGrants: [{ id: 'g' }] });
    db.aiAdminAuditLog.findFirst.mockResolvedValue({ id: 'audit-1' });

    await requestSupportSession();

    expect(db.aiAdminAuditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user_1',
          action: 'support.enter',
          entityType: 'support_grant',
          entityId: { in: ['g'] },
        },
      })
    );
  });

  it('nothing is shown when the org granted support but this admin never entered under it', async () => {
    db.org.findUnique.mockResolvedValue({ name: 'Customer Ltd', supportGrants: [{ id: 'g' }] });

    await expect(requestSupportSession()).resolves.toBeNull();
  });

  it('nothing is shown for an org that never granted support', async () => {
    await expect(requestSupportSession()).resolves.toBeNull();
  });
});

describe('no support session', () => {
  it('a member of the org is never in one', async () => {
    signedIn('USER', CUSTOMER);
    db.orgMembership.findUnique.mockResolvedValue({ role: 'ADMIN', org: { status: 'ACTIVE' } });

    await expect(requestSupportSession()).resolves.toBeNull();
    expect(db.orgSupportGrant.findFirst).not.toHaveBeenCalled();
  });

  it('a platform admin in the install org is not in one', async () => {
    signedIn('ADMIN', INSTALL_ORG_ID);
    db.orgMembership.findUnique.mockResolvedValue({ role: 'OWNER', org: { status: 'ACTIVE' } });

    await expect(requestSupportSession()).resolves.toBeNull();
    await expect(adminPageViewerTier()).resolves.toBe('platform');
  });

  it('at single there is none, and no grant is read', async () => {
    mockEnv.TENANCY_MODE = 'single';
    signedIn('ADMIN', null);

    await expect(requestSupportSession()).resolves.toBeNull();
    expect(db.orgSupportGrant.findFirst).not.toHaveBeenCalled();
  });
});
