/**
 * Maintenance Wrapper Component (Phase 4.4)
 *
 * Checks if MAINTENANCE_MODE is enabled and shows the maintenance page
 * for non-admin users. Admins can bypass maintenance mode.
 *
 * This component should be used in layouts that need maintenance mode support.
 *
 * @example
 * ```tsx
 * // In a layout file
 * export default async function Layout({ children }) {
 *   return (
 *     <MaintenanceWrapper>
 *       {children}
 *     </MaintenanceWrapper>
 *   );
 * }
 * ```
 */

import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { MaintenancePage } from '@/components/maintenance-page';
import { logger } from '@/lib/logging';
import { canAdminister } from '@/lib/auth/authorization';
import { sessionPrincipal, type SessionLike } from '@/lib/auth/session-principal';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

interface MaintenanceWrapperProps {
  children: React.ReactNode;
}

/**
 * May this session see the site during maintenance? The policy's platform
 * question, about the principal the guards build.
 *
 * One exception: a support session (§121 t-824) presents as a plain user
 * inside the customer's org, which would leave a platform admin on the
 * maintenance page everywhere, including the console whose banner is their
 * only way back. Maintenance is the vendor's own state, not the org's, so the
 * question is asked about who they are outside the org: their stored role,
 * with no org facts.
 */
async function bypassesMaintenance(
  session: SessionLike,
  headerOrgId: string | null
): Promise<boolean> {
  const { principal, scope, support } = await sessionPrincipal(session, headerOrgId);
  if (support) {
    return canAdminister(
      { userId: session.user.id, role: session.user.role, credential: 'session' },
      null,
      {}
    );
  }
  return canAdminister(principal, null, scope);
}

/**
 * Get the maintenance mode flag status
 */
async function getMaintenanceFlag() {
  try {
    const flag = await prisma.featureFlag.findUnique({
      where: { name: 'MAINTENANCE_MODE' },
      select: {
        enabled: true,
        metadata: true,
      },
    });

    if (!flag) {
      return { enabled: false, metadata: null };
    }

    return {
      enabled: flag.enabled,
      metadata: flag.metadata as { message?: string; estimatedDowntime?: string } | null,
    };
  } catch (error) {
    logger.error('Error checking maintenance mode', error);
    return { enabled: false, metadata: null };
  }
}

/**
 * Wrapper that shows maintenance page when MAINTENANCE_MODE is enabled.
 * Admin users can bypass the maintenance page.
 */
export async function MaintenanceWrapper({ children }: MaintenanceWrapperProps) {
  // Get maintenance mode status
  const { enabled, metadata } = await getMaintenanceFlag();

  // If maintenance mode is not enabled, render children normally
  if (!enabled) {
    return <>{children}</>;
  }

  // Check if user is admin (they can bypass maintenance mode). On any
  // failure, treat as non-admin and show the maintenance page for safety.
  let isAdmin = false;
  try {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    // The authorization policy, not a role read. Bypassing the maintenance page
    // reaches the whole site, so this is an access decision and belongs behind
    // the same seam as the guards — otherwise a fork that narrows
    // `canAdminister` still lets every stored `role: 'ADMIN'` past here, and
    // safe mode would close the admin console while leaving this open.
    // The principal the guards and the admin layout build — the entered
    // org and the caller's verified role in it (§111 t-810) — so a policy
    // that reads `viewer.orgRole` answers the bypass as it answers the console.
    if (session) {
      isAdmin = await bypassesMaintenance(session, requestHeaders.get(TENANT_HEADER_NAME) || null);
    }
  } catch {
    // If session check fails, show maintenance page for safety
  }

  // Admins can bypass maintenance mode
  if (isAdmin) {
    return <>{children}</>;
  }

  // Show maintenance page for non-admin users
  return (
    <MaintenancePage
      message={metadata?.message}
      estimatedDowntime={metadata?.estimatedDowntime}
      isAdmin={false}
    />
  );
}

/**
 * Export a version that shows admin bypass option
 *
 * Use this when you want admins to see they're bypassing maintenance mode.
 */
export async function MaintenanceWrapperWithAdminNotice({ children }: MaintenanceWrapperProps) {
  // Get maintenance mode status
  const { enabled, metadata } = await getMaintenanceFlag();

  // If maintenance mode is not enabled, render children normally
  if (!enabled) {
    return <>{children}</>;
  }

  // Check if user is admin. On any failure, treat as non-admin and show the
  // maintenance page for safety.
  let isAdmin = false;
  try {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    // The authorization policy, not a role read. Bypassing the maintenance page
    // reaches the whole site, so this is an access decision and belongs behind
    // the same seam as the guards — otherwise a fork that narrows
    // `canAdminister` still lets every stored `role: 'ADMIN'` past here, and
    // safe mode would close the admin console while leaving this open.
    // The principal the guards and the admin layout build — the entered
    // org and the caller's verified role in it (§111 t-810) — so a policy
    // that reads `viewer.orgRole` answers the bypass as it answers the console.
    if (session) {
      isAdmin = await bypassesMaintenance(session, requestHeaders.get(TENANT_HEADER_NAME) || null);
    }
  } catch {
    // If session check fails, show maintenance page for safety
  }

  // Admins can bypass but see a notice
  if (isAdmin) {
    return (
      <>
        <div className="border-b border-amber-500/50 bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-700 dark:text-amber-400">
          Maintenance mode is active. You can access the site because you are an admin.
        </div>
        {children}
      </>
    );
  }

  // Show maintenance page for non-admin users
  return (
    <MaintenancePage
      message={metadata?.message}
      estimatedDowntime={metadata?.estimatedDowntime}
      isAdmin={false}
    />
  );
}
