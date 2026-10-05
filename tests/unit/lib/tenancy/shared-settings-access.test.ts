/**
 * Tests: whether an admin page may offer to change shared settings (§107 t-753).
 *
 * The page-side answer to t-751's server rule, read from the request the way
 * `GET /api/v1/orgs` reads it: the resolver header, else the session's
 * active org, else the install org at `single`. The layout passes the session
 * it already has; the header comes through `headers()`, and the install-org
 * membership (asked only when read-only) through Prisma, both mocked at the
 * boundary.
 *
 * @see lib/tenancy/shared-settings-access.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
vi.mock('@/lib/db/client', () => ({ prisma: { orgMembership: { findUnique: vi.fn() } } }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
import { logger } from '@/lib/logging';

import { headers } from 'next/headers';
import { prisma } from '@/lib/db/client';
import { getSharedSettingsAccess } from '@/lib/tenancy/shared-settings-access';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

const CUSTOMER = 'cmorg00000000000customer';
const USER_ID = 'cmuser00000000000000user1';

/** The request: the session's active org, and the resolver header if any. */
function access(activeOrgId: string | null, headerOrgId?: string) {
  vi.mocked(headers).mockResolvedValue(
    new Headers(headerOrgId ? { [TENANT_HEADER_NAME]: headerOrgId } : {})
  );
  return getSharedSettingsAccess({ user: { id: USER_ID }, session: { activeOrgId } });
}

function installOrgMember(member: boolean) {
  vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue(
    (member ? { orgId: INSTALL_ORG_ID } : null) as never
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
  installOrgMember(true);
});

describe('getSharedSettingsAccess', () => {
  describe('at single', () => {
    it('is editable in the install org, named or defaulted', async () => {
      for (const activeOrgId of [INSTALL_ORG_ID, null]) {
        expect(await access(activeOrgId)).toEqual({
          isInstallOrg: true,
          readOnly: false,
          canSwitch: false,
          installOrgMember: true,
        });
      }
    });

    it('stays editable from another org — the server allows every write at single', async () => {
      expect(await access(CUSTOMER)).toEqual({
        isInstallOrg: false,
        readOnly: false,
        canSwitch: false,
        installOrgMember: true,
      });
      // Nothing to offer, so nothing is read.
      expect(prisma.orgMembership.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('at multi', () => {
    beforeEach(() => {
      mockEnv.TENANCY_MODE = 'multi';
    });

    it('is editable in the install org, without reading a membership', async () => {
      expect(await access(INSTALL_ORG_ID)).toEqual({
        isInstallOrg: true,
        readOnly: false,
        canSwitch: false,
        installOrgMember: true,
      });
      expect(prisma.orgMembership.findUnique).not.toHaveBeenCalled();
    });

    it('is read-only in a customer org, with a switch on offer to an install-org member', async () => {
      expect(await access(CUSTOMER)).toEqual({
        isInstallOrg: false,
        readOnly: true,
        canSwitch: true,
        installOrgMember: true,
      });
      expect(prisma.orgMembership.findUnique).toHaveBeenCalledWith({
        where: { orgId_userId: { orgId: INSTALL_ORG_ID, userId: USER_ID } },
        select: { orgId: true },
      });
    });

    it('offers no switch to a user who is not a member of the install org', async () => {
      installOrgMember(false);
      expect(await access(CUSTOMER)).toEqual({
        isInstallOrg: false,
        readOnly: true,
        canSwitch: false,
        installOrgMember: false,
      });
    });

    it('survives a failed membership read: it logs, and leaves the answer to the switch route', async () => {
      // The layout asks on every admin page; a failed read must not take the
      // admin tree down. Offering the switch is safe — the route reads the
      // same row and refuses a non-member.
      vi.mocked(prisma.orgMembership.findUnique).mockRejectedValue(new Error('pool exhausted'));
      expect(await access(CUSTOMER)).toEqual({
        isInstallOrg: false,
        readOnly: true,
        canSwitch: true,
        installOrgMember: true,
      });
      expect(logger.error).toHaveBeenCalledWith(
        'Shared-settings access: install-org membership read failed',
        expect.any(Error),
        { userId: USER_ID }
      );
    });

    it('is read-only when the session names no org — there is none to default to', async () => {
      expect((await access(null)).readOnly).toBe(true);
    });

    it('lets the resolver header decide over the session, and offers no switch', async () => {
      // The session points at the install org, but the request's address
      // names a customer: the header wins, as it does in the guard, and a
      // session switch would not move the request.
      expect(await access(INSTALL_ORG_ID, CUSTOMER)).toEqual({
        isInstallOrg: false,
        readOnly: true,
        canSwitch: false,
        installOrgMember: true,
      });
    });

    it('is editable when the header names the install org', async () => {
      expect(await access(CUSTOMER, INSTALL_ORG_ID)).toEqual({
        isInstallOrg: true,
        readOnly: false,
        canSwitch: false,
        installOrgMember: true,
      });
    });
  });
});
