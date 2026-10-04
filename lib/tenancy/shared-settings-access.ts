/**
 * Whether an admin page may offer to change shared settings (§107 t-753).
 *
 * The server refuses a shared-settings write from any org but the install org
 * at `multi` (t-751, `lib/tenancy/shared-settings.ts`). This is the page-side
 * answer to the same question, so the pages can say so before the admin
 * tries: the admin layout reads it once per request and hands it to
 * `SharedSettingsAccessProvider`, and a server page that renders its own
 * create link reads it too (the read is cached per request).
 *
 * The org is derived as `GET /api/v1/orgs` derives it for a cookie session:
 * the proxy's resolver header, else the session's pointer, else the install
 * org at `single`. It is not verified here — the guard does that on every
 * call, and a page that guessed wrong would only show or hide a button whose
 * request the server answers either way.
 */
import { cache } from 'react';
import { headers } from 'next/headers';
import { getServerSession } from '@/lib/auth/utils';
import { isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';
import { sessionActingOrgId } from '@/lib/tenancy/entry';

export interface SharedSettingsAccess {
  /** This request acts for the install org. Always true at `single` unless the session chose another org. */
  isInstallOrg: boolean;
  /** Shared settings can be read but not changed from here: `multi`, outside the install org. */
  readOnly: boolean;
  /**
   * Switching the session's org would change the answer. False when the
   * resolver header decided the org (a fork resolving tenants by hostname):
   * the header wins over the session, so a switch would not move the request.
   */
  canSwitch: boolean;
}

export const getSharedSettingsAccess = cache(async (): Promise<SharedSettingsAccess> => {
  const [session, requestHeaders] = await Promise.all([getServerSession(), headers()]);
  const headerOrgId = requestHeaders.get(TENANT_HEADER_NAME);
  const orgId = sessionActingOrgId(headerOrgId, session?.session.activeOrgId);
  const isInstallOrg = orgId === INSTALL_ORG_ID;
  return {
    isInstallOrg,
    readOnly: isMultiTenant() && !isInstallOrg,
    canSwitch: !headerOrgId,
  };
});
