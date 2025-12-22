import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoutButton } from '@/components/auth/logout-button';

/**
 * Dashboard Page
 *
 * Main dashboard for authenticated users.
 * Shows user information and provides access to app features.
 */
export default async function DashboardPage() {
  // Get the current user session
  const session = await getServerSession();

  // Clear invalid session cookie and redirect if not authenticated
  // This prevents infinite redirect loops when user is deleted but cookie remains
  if (!session) {
    clearInvalidSession('/dashboard');
  }

  const { user } = session;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <LogoutButton variant="outline" redirectTo="/login" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Welcome, {user.name}!</CardTitle>
          <CardDescription>You are successfully authenticated</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between border-b py-2">
              <span className="text-muted-foreground text-sm font-medium">Name</span>
              <span className="text-sm">{user.name}</span>
            </div>

            <div className="flex items-center justify-between border-b py-2">
              <span className="text-muted-foreground text-sm font-medium">Email</span>
              <span className="text-sm">{user.email}</span>
            </div>

            <div className="flex items-center justify-between border-b py-2">
              <span className="text-muted-foreground text-sm font-medium">Email Verified</span>
              <span className="text-sm">{user.emailVerified ? 'Yes' : 'No'}</span>
            </div>

            <div className="flex items-center justify-between border-b py-2">
              <span className="text-muted-foreground text-sm font-medium">Role</span>
              <span className="text-sm">{user.role || 'USER'}</span>
            </div>

            <div className="flex items-center justify-between py-2">
              <span className="text-muted-foreground text-sm font-medium">User ID</span>
              <span className="font-mono text-sm text-xs">{user.id}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
