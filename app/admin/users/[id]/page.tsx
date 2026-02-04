import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
import { getServerSession } from '@/lib/auth/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, Mail, Phone, MapPin, Clock, Calendar, RefreshCw, Pencil } from 'lucide-react';
import { ClientDate } from '@/components/ui/client-date';
import type { AdminUser } from '@/types/admin';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `User ${id}`,
    description: 'View user profile',
  };
}

/**
 * Fetch user by ID from API
 */
async function getUser(id: string): Promise<AdminUser | null> {
  try {
    const res = await serverFetch(API.USERS.byId(id));

    if (!res.ok) {
      return null;
    }

    const data = await parseApiResponse<AdminUser>(res);

    if (!data.success) {
      return null;
    }

    return {
      id: data.data.id,
      name: data.data.name,
      email: data.data.email,
      emailVerified: data.data.emailVerified,
      image: data.data.image,
      role: data.data.role,
      bio: data.data.bio ?? null,
      createdAt: new Date(data.data.createdAt),
      updatedAt: new Date(data.data.updatedAt),
      phone: data.data.phone ?? null,
      timezone: data.data.timezone ?? null,
      location: data.data.location ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Admin User Profile Page
 *
 * Read-only view of user profile. Links to edit page for modifications.
 */
export default async function AdminUserProfilePage({ params }: PageProps) {
  const { id } = await params;

  const session = await getServerSession();
  if (!session) {
    notFound();
  }

  const user = await getUser(id);

  if (!user) {
    notFound();
  }

  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const timezoneDisplay = user.timezone?.replace('_', ' ').replace('/', ' / ') || 'Not set';

  return (
    <div className="space-y-6">
      {/* Navigation bar */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" asChild className="-ml-4">
          <Link href="/admin/users">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Users
          </Link>
        </Button>
        <Button asChild>
          <Link href={`/admin/users/${id}/edit`}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit User
          </Link>
        </Button>
      </div>

      {/* Profile Header Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            <Avatar className="h-24 w-24">
              <AvatarImage src={user.image || undefined} alt={user.name} />
              <AvatarFallback className="text-2xl">{initials}</AvatarFallback>
            </Avatar>

            <div className="flex-1 text-center sm:text-left">
              <h1 className="text-2xl font-bold">{user.name}</h1>
              <p className="text-muted-foreground">{user.email}</p>
              <div className="mt-2 flex flex-wrap justify-center gap-2 sm:justify-start">
                <Badge variant="secondary">{user.role || 'USER'}</Badge>
                {user.emailVerified ? (
                  <Badge variant="outline" className="text-green-600 dark:text-green-400">
                    Verified
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
                    Unverified
                  </Badge>
                )}
              </div>
            </div>
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

      {/* Profile Details Card */}
      <Card>
        <CardHeader>
          <CardTitle>Profile Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex items-start gap-3">
              <Mail className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Email</p>
                <p className="font-medium">{user.email}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Phone className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Phone</p>
                <p className="font-medium">{user.phone || 'Not set'}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <MapPin className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Location</p>
                <p className="font-medium">{user.location || 'Not set'}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Clock className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Timezone</p>
                <p className="font-medium">{timezoneDisplay}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Calendar className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Member Since</p>
                <p className="font-medium">
                  <ClientDate date={user.createdAt} />
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <RefreshCw className="text-muted-foreground mt-0.5 h-5 w-5" />
              <div>
                <p className="text-muted-foreground text-sm">Last Updated</p>
                <p className="font-medium">
                  <ClientDate date={user.updatedAt} />
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* System Info */}
      <Card>
        <CardHeader>
          <CardTitle>System Info</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3">
            <div>
              <p className="text-muted-foreground text-sm">User ID</p>
              <p className="font-mono text-sm">{user.id}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
