/**
 * Profile Page Loading Skeleton
 *
 * Shown while the profile page is loading.
 */

import { Card, CardContent, CardHeader } from '@/components/ui/card';

export default function ProfileLoading() {
  return (
    <div className="space-y-6">
      {/* Profile Header Skeleton */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            {/* Avatar Skeleton */}
            <div className="bg-muted h-24 w-24 animate-pulse rounded-full" />

            {/* Name and Role Skeleton */}
            <div className="flex-1 space-y-2 text-center sm:text-left">
              <div className="bg-muted mx-auto h-8 w-48 animate-pulse rounded sm:mx-0" />
              <div className="bg-muted mx-auto h-4 w-32 animate-pulse rounded sm:mx-0" />
              <div className="flex justify-center gap-2 sm:justify-start">
                <div className="bg-muted h-6 w-16 animate-pulse rounded" />
                <div className="bg-muted h-6 w-20 animate-pulse rounded" />
              </div>
            </div>

            {/* Edit Button Skeleton */}
            <div className="bg-muted h-10 w-32 animate-pulse rounded" />
          </div>

          {/* Bio Skeleton */}
          <div className="bg-muted my-6 h-px w-full" />
          <div className="space-y-2">
            <div className="bg-muted h-4 w-16 animate-pulse rounded" />
            <div className="bg-muted h-20 w-full animate-pulse rounded" />
          </div>
        </CardContent>
      </Card>

      {/* Profile Details Skeleton */}
      <Card>
        <CardHeader>
          <div className="bg-muted h-6 w-32 animate-pulse rounded" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="bg-muted mt-0.5 h-5 w-5 animate-pulse rounded" />
                <div className="space-y-1">
                  <div className="bg-muted h-4 w-16 animate-pulse rounded" />
                  <div className="bg-muted h-5 w-32 animate-pulse rounded" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
