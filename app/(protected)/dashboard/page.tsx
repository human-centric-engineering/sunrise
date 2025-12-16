import { getServerSession } from '@/lib/auth/utils'
import { redirect } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogoutButton } from '@/components/auth/logout-button'

/**
 * Dashboard Page
 *
 * Main dashboard for authenticated users.
 * Shows user information and provides access to app features.
 */
export default async function DashboardPage() {
  // Get the current user session
  const session = await getServerSession()

  // Redirect to login if not authenticated
  // (proxy should handle this, but this is a fallback)
  if (!session) {
    redirect('/login')
  }

  const { user } = session

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <LogoutButton variant="outline" redirectTo="/login" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Welcome, {user.name}!</CardTitle>
          <CardDescription>
            You are successfully authenticated
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-sm font-medium text-muted-foreground">
                Name
              </span>
              <span className="text-sm">{user.name}</span>
            </div>

            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-sm font-medium text-muted-foreground">
                Email
              </span>
              <span className="text-sm">{user.email}</span>
            </div>

            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-sm font-medium text-muted-foreground">
                Email Verified
              </span>
              <span className="text-sm">
                {user.emailVerified ? 'Yes' : 'No'}
              </span>
            </div>

            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-sm font-medium text-muted-foreground">
                Role
              </span>
              <span className="text-sm">{user.role || 'USER'}</span>
            </div>

            <div className="flex items-center justify-between py-2">
              <span className="text-sm font-medium text-muted-foreground">
                User ID
              </span>
              <span className="text-sm font-mono text-xs">{user.id}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
