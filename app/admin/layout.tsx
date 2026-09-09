import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/auth/utils';
import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { AdminHeader } from '@/components/admin/admin-header';
import { InFlightExecutionBanner } from '@/components/admin/orchestration/in-flight-execution-banner';
import { BRAND } from '@/lib/brand';
import { AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';
import { canAdminister } from '@/lib/auth/authorization';

export const metadata: Metadata = {
  title: {
    template: `%s - Admin - ${BRAND.name}`,
    default: `Admin - ${BRAND.name}`,
  },
  description: `Admin dashboard for ${BRAND.name}`,
};

/**
 * Admin Layout (Phase 4.4)
 *
 * Layout for all admin routes.
 * Requires ADMIN role - non-admins are redirected to dashboard.
 * Unauthenticated users are redirected to login.
 */
export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession();

  // Redirect to login if not authenticated
  if (!session) {
    redirect('/login');
  }

  // Redirect to dashboard if the authorization policy says this principal does
  // not administer. The third of the three places Sunrise asks the question —
  // the guards cover the API, this covers the admin tree's own shell. A cookie
  // session is the only way to reach a layout, so the credential is not in
  // doubt here.
  if (
    !(await canAdminister({
      userId: session.user.id,
      role: session.user.role,
      credential: 'session',
    }))
  ) {
    redirect(AUTH_LANDING_ROUTE);
  }

  return (
    <div className="bg-background flex h-screen overflow-hidden">
      <AdminSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <AdminHeader />
        <InFlightExecutionBanner />
        <main className="flex-1 overflow-y-auto overscroll-contain">
          <div className="p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
