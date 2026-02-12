import Link from 'next/link';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { getVerificationStatus } from '@/lib/auth/verification-status';
import { prisma } from '@/lib/db/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmailStatusCard } from '@/components/dashboard/email-status-card';
import { User, Settings, Shield } from 'lucide-react';

/**
 * Dashboard Page
 *
 * Main dashboard for authenticated users.
 * Shows user information, quick stats, and provides access to app features.
 *
 * Phase 3.2: Enhanced with profile stats and navigation
 */
export default async function DashboardPage() {
  const session = await getServerSession();

  if (!session) {
    clearInvalidSession('/dashboard');
  }

  // Fetch full user data for profile completion calculation
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      role: true,
      bio: true,
      phone: true,
      timezone: true,
      location: true,
    },
  });

  if (!user) {
    clearInvalidSession('/dashboard');
  }

  // Get email verification status
  const verificationStatus = await getVerificationStatus(user.email, user.emailVerified);

  // Calculate profile completion percentage (includes avatar)
  const profileFields = [
    user.name,
    user.email,
    user.image,
    user.bio,
    user.phone,
    user.timezone,
    user.location,
  ];
  const completedFields = profileFields.filter(Boolean).length;
  const profileCompletion = Math.round((completedFields / profileFields.length) * 100);

  // Get user initials for avatar
  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="space-y-6">
      {/* Header */}
      <h1 className="text-3xl font-bold">Dashboard</h1>

      {/* Welcome Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <Avatar className="h-16 w-16">
              <AvatarImage src={user.image || undefined} alt={user.name} />
              <AvatarFallback className="text-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <h2 className="text-2xl font-bold">Hello, {user.name.split(' ')[0]}!</h2>
              <p className="text-muted-foreground">{user.email}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Quick Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        {/* Profile Completion */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Profile Completion</CardTitle>
            <User className="text-muted-foreground h-4 w-4" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{profileCompletion}%</div>
            <p className="text-muted-foreground text-xs">
              {completedFields} of {profileFields.length} fields completed
            </p>
            <div className="bg-muted mt-2 h-2 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-all"
                style={{ width: `${profileCompletion}%` }}
              />
            </div>
          </CardContent>
        </Card>

        {/* Email Status */}
        <EmailStatusCard status={verificationStatus} email={user.email} />

        {/* Account Status */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Account Status</CardTitle>
            <Shield className="text-muted-foreground h-4 w-4" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{user.role || 'USER'}</Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">Your account role</p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Manage your account</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4">
          <Button asChild variant="outline">
            <Link href="/profile">
              <User className="mr-2 h-4 w-4" />
              View Profile
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/settings">
              <Settings className="mr-2 h-4 w-4" />
              Account Settings
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
