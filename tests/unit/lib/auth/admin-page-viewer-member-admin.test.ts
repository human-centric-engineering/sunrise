/**
 * Tests: the view behind the member platform admin banner (t-1032)
 *
 * Drives the REAL `sessionPrincipal`, entry and default policy with the reads
 * mocked at Prisma. `requestMemberPlatformAdmin()` is the remedy for the
 * refusals a member platform admin now meets in a customer org: it names the
 * org, their role in it and the install org, for a platform admin acting
 * there as a member — and is `null` for everyone else.
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
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/auth/utils', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { adminPageViewerTier, requestMemberPlatformAdmin } from '@/lib/auth/admin-page-viewer';
import { getServerSession } from '@/lib/auth/utils';
import { headers } from 'next/headers';

const CUSTOMER = 'cmorg00000000000customer1';

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
  db.orgMembership.findUnique.mockResolvedValue({ role: 'ADMIN', org: { status: 'ACTIVE' } });
  db.orgSupportGrant.findFirst.mockResolvedValue(null);
  db.org.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve({ name: where.id === INSTALL_ORG_ID ? 'Vendor' : 'Customer Ltd' })
  );
  signedIn('ADMIN', CUSTOMER);
});

describe('a platform admin acting in a customer org as a member', () => {
  it('is an org viewer there', async () => {
    await expect(adminPageViewerTier()).resolves.toBe('org');
  });

  it('is told where they are, as what, and where platform work is done', async () => {
    await expect(requestMemberPlatformAdmin()).resolves.toEqual({
      orgName: 'Customer Ltd',
      orgRole: 'ADMIN',
      installOrgName: 'Vendor',
      viaResolver: false,
    });
  });

  it('notes when the org came from a resolver header, which a switch cannot leave', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ [TENANT_HEADER_NAME]: CUSTOMER }));
    await expect(requestMemberPlatformAdmin()).resolves.toMatchObject({ viaResolver: true });
  });

  it('is shown it as an org MEMBER too, whom the console does not admit', async () => {
    db.orgMembership.findUnique.mockResolvedValue({ role: 'MEMBER', org: { status: 'ACTIVE' } });
    await expect(requestMemberPlatformAdmin()).resolves.toMatchObject({ orgRole: 'MEMBER' });
  });
});

describe('everyone else sees nothing', () => {
  it('a platform admin in the install org', async () => {
    signedIn('ADMIN', INSTALL_ORG_ID);
    await expect(requestMemberPlatformAdmin()).resolves.toBeNull();
  });

  it('an org admin who is not a platform admin', async () => {
    signedIn('USER', CUSTOMER);
    await expect(requestMemberPlatformAdmin()).resolves.toBeNull();
  });

  it('a support session, which has its own banner', async () => {
    db.orgMembership.findUnique.mockResolvedValue(null);
    db.orgSupportGrant.findFirst.mockResolvedValue({
      id: 'grant-1',
      level: 'ADMIN',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    await expect(requestMemberPlatformAdmin()).resolves.toBeNull();
  });

  it('a platform admin whose entry was refused', async () => {
    db.orgMembership.findUnique.mockResolvedValue(null);
    await expect(requestMemberPlatformAdmin()).resolves.toBeNull();
  });

  it('anyone at single, with no read made', async () => {
    mockEnv.TENANCY_MODE = 'single';
    await expect(requestMemberPlatformAdmin()).resolves.toBeNull();
    expect(db.orgMembership.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — single installs pay nothing;
  });

  it('no session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    await expect(requestMemberPlatformAdmin()).resolves.toBeNull();
  });
});
