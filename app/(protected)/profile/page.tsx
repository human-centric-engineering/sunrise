/**
 * Profile Page
 *
 * View-only page displaying user profile information.
 * Links to settings for editing.
 *
 * Phase 3.2: User Management
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { prisma } from '@/lib/db/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Mail, MapPin, Clock, Calendar, Pencil } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Profile - Sunrise',
  description: 'View your profile',
};

export default async function ProfilePage() {
  const session = await getServerSession();

  if (!session) {
    clearInvalidSession('/profile');
  }

  // Fetch full user profile
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      role: true,
      createdAt: true,
      bio: true,
      phone: true,
      timezone: true,
      location: true,
    },
  });

  if (!user) {
    clearInvalidSession('/profile');
  }

  // Get user initials for avatar fallback
  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  // Format timezone for display
  const timezoneDisplay = user.timezone?.replace('_', ' ').replace('/', ' / ') || 'UTC';

  return (
    <div className="space-y-6">
      {/* Profile Header */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            {/* Avatar */}
            <Avatar className="h-24 w-24">
              <AvatarImage src={user.image || undefined} alt={user.name} />
              <AvatarFallback className="text-2xl">{initials}</AvatarFallback>
            </Avatar>

            {/* Name and Role */}
            <div className="flex-1 text-center sm:text-left">
              <h1 className="text-2xl font-bold">{user.name}</h1>
              <p className="text-muted-foreground">{user.email}</p>
              <div className="mt-2 flex flex-wrap justify-center gap-2 sm:justify-start">
                <Badge variant="secondary">{user.role || 'USER'}</Badge>
                {user.emailVerified && (
                  <Badge variant="outline" className="text-green-600 dark:text-green-400">
                    Verified
                  </Badge>
                )}
              </div>
            </div>

            {/* Edit Button */}
            <Button asChild variant="outline">
              <Link href="/settings">
                <Pencil className="mr-2 h-4 w-4" />
                Edit Profile
              </Link>
            </Button>
          </div>

          {/* Bio */}
          {user.bio && (
            <>
              <Separator className="my-6" />
              <div>
                <h2 className="mb-2 font-medium">About</h2>
                <p className="text-muted-foreground whitespace-pre-wrap">{user.bio}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Profile Details */}
      <Card>
        <CardHeader>
          <CardTitle>Profile Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Email */}
            <div className="flex items-start gap-3">
              <Mail className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Email</p>
                <p className="font-medium">{user.email}</p>
              </div>
            </div>

            {/* Location */}
            <div className="flex items-start gap-3">
              <MapPin className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Location</p>
                <p className="font-medium">{user.location || 'Not set'}</p>
              </div>
            </div>

            {/* Timezone */}
            <div className="flex items-start gap-3">
              <Clock className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Timezone</p>
                <p className="font-medium">{timezoneDisplay}</p>
              </div>
            </div>

            {/* Member Since */}
            <div className="flex items-start gap-3">
              <Calendar className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Member Since</p>
                <p className="font-medium">
                  {new Date(user.createdAt).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
