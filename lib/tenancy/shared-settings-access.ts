/**
 * Whether an admin page may offer to change shared settings (§107 t-753).
 *
 * The server refuses a shared-settings write from any org but the install org
 * at `multi` (t-751, `lib/tenancy/shared-settings.ts`). This is the page-side
 * answer to the same question, so the pages can say so before the admin
 * tries. The admin layout asks it once per request, with the session it has
 * already read, and hands the answer to `SharedSettingsAccessProvider`; every
 * page and component below reads that one answer, so a page never mixes two.
 *
 * The org is derived as `GET /api/v1/orgs` derives it for a cookie session:
 * the proxy's resolver header, else the session's pointer, else the install
 * org at `single`. It is not verified here — the guard does that on every
 * call, and a page that guessed wrong would only show or hide a button whose
 * request the server answers either way.
 */
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/client';
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
   * Switching the session to the install org would make them editable. False
   * when the resolver header decided the org (a fork resolving tenants by
   * hostname: the header wins over the session, so a switch would not move
   * the request), and when the user is not a member of the install org (the
   * switch would be refused). Only worked out where it matters: when
   * `readOnly`.
   */
  canSwitch: boolean;
  /**
   * The user is a member of the install org, so someone could switch them
   * there. Only read when `readOnly`; `true` otherwise, where it does not
   * matter.
   */
  installOrgMember: boolean;
}

export async function getSharedSettingsAccess(session: {
  user: { id: string };
  session: { activeOrgId?: string | null };
}): Promise<SharedSettingsAccess> {
  const headerOrgId = (await headers()).get(TENANT_HEADER_NAME);
  const orgId = sessionActingOrgId(headerOrgId, session.session.activeOrgId);
  const isInstallOrg = orgId === INSTALL_ORG_ID;
  const readOnly = isMultiTenant() && !isInstallOrg;
  const installOrgMember = readOnly ? await isInstallOrgMember(session.user.id) : true;
  return {
    isInstallOrg,
    readOnly,
    canSwitch: readOnly && !headerOrgId && installOrgMember,
    installOrgMember,
  };
}

/**
 * The switch route's own membership read, asked before offering it. An
 * `OrgMembership` row is a system row (it decides which org a request acts
 * for), so it reads with no org entered, as the switch does.
 */
async function isInstallOrgMember(userId: string): Promise<boolean> {
  const membership = await prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId: INSTALL_ORG_ID, userId } },
    select: { orgId: true },
  });
  return membership !== null;
}
