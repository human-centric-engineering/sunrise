/**
 * Tests: whether an admin page may offer to change shared settings (§107 t-753).
 *
 * The page-side answer to t-751's server rule, read from the request the way
 * `GET /api/v1/orgs` reads it: the resolver header, else the session's
 * active org, else the install org at `single`. Each case drives the session
 * and the header through their real readers (`getServerSession`, `headers()`),
 * mocked at the boundary.
 *
 * @see lib/tenancy/shared-settings-access.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth/utils', () => ({ getServerSession: vi.fn() }));

import { headers } from 'next/headers';
import { getServerSession } from '@/lib/auth/utils';
import { getSharedSettingsAccess } from '@/lib/tenancy/shared-settings-access';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

const CUSTOMER = 'cmorg00000000000customer';

/** The request: the session's active org, and the resolver header if any. */
function request(activeOrgId: string | null | undefined, headerOrgId?: string) {
  vi.mocked(getServerSession).mockResolvedValue(
    activeOrgId === undefined ? null : ({ session: { activeOrgId } } as never)
  );
  vi.mocked(headers).mockResolvedValue(
    new Headers(headerOrgId ? { [TENANT_HEADER_NAME]: headerOrgId } : {})
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
});

describe('getSharedSettingsAccess', () => {
  describe('at single', () => {
    it('is editable in the install org, named or defaulted', async () => {
      for (const activeOrgId of [INSTALL_ORG_ID, null]) {
        request(activeOrgId);
        expect(await getSharedSettingsAccess()).toEqual({
          isInstallOrg: true,
          readOnly: false,
          canSwitch: true,
        });
      }
    });

    it('stays editable from another org — the server allows every write at single', async () => {
      request(CUSTOMER);
      expect(await getSharedSettingsAccess()).toEqual({
        isInstallOrg: false,
        readOnly: false,
        canSwitch: true,
      });
    });
  });

  describe('at multi', () => {
    beforeEach(() => {
      mockEnv.TENANCY_MODE = 'multi';
    });

    it('is editable in the install org', async () => {
      request(INSTALL_ORG_ID);
      expect(await getSharedSettingsAccess()).toEqual({
        isInstallOrg: true,
        readOnly: false,
        canSwitch: true,
      });
    });

    it('is read-only in a customer org, with a switch on offer', async () => {
      request(CUSTOMER);
      expect(await getSharedSettingsAccess()).toEqual({
        isInstallOrg: false,
        readOnly: true,
        canSwitch: true,
      });
    });

    it('is read-only when the session names no org — there is none to default to', async () => {
      request(null);
      expect((await getSharedSettingsAccess()).readOnly).toBe(true);
    });

    it('is read-only with no session at all', async () => {
      request(undefined);
      expect((await getSharedSettingsAccess()).readOnly).toBe(true);
    });

    it('lets the resolver header decide over the session, and offers no switch', async () => {
      // The session points at the install org, but the request's address
      // names a customer: the header wins, as it does in the guard, and a
      // session switch would not move the request.
      request(INSTALL_ORG_ID, CUSTOMER);
      expect(await getSharedSettingsAccess()).toEqual({
        isInstallOrg: false,
        readOnly: true,
        canSwitch: false,
      });
    });

    it('is editable when the header names the install org, still with no switch', async () => {
      request(CUSTOMER, INSTALL_ORG_ID);
      expect(await getSharedSettingsAccess()).toEqual({
        isInstallOrg: true,
        readOnly: false,
        canSwitch: false,
      });
    });
  });
});
