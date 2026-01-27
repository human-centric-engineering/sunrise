import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/auth/utils';
import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { AdminHeader } from '@/components/admin/admin-header';

export const metadata: Metadata = {
  title: {
    template: '%s - Admin - Sunrise',
    default: 'Admin - Sunrise',
  },
  description: 'Admin dashboard for Sunrise',
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

  // Redirect to dashboard if not an admin
  if (session.user.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  return (
    <div className="bg-background flex h-screen overflow-hidden">
      <AdminSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <AdminHeader />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
