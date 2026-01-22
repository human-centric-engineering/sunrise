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

interface MaintenanceWrapperProps {
  children: React.ReactNode;
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

  // Check if user is admin (they can bypass maintenance mode)
  try {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    const isAdmin = session?.user?.role === 'ADMIN';

    // Admins can bypass maintenance mode
    if (isAdmin) {
      return <>{children}</>;
    }
  } catch {
    // If session check fails, show maintenance page for safety
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

  // Check if user is admin
  try {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    const isAdmin = session?.user?.role === 'ADMIN';

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
  } catch {
    // If session check fails, show maintenance page for safety
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
