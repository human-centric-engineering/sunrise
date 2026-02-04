/**
 * Admin Loading Skeleton
 *
 * Shown while admin pages are loading.
 * Provides a generic skeleton that works for all admin sub-routes.
 */

import { Card, CardContent, CardHeader } from '@/components/ui/card';

export default function AdminLoading() {
  return (
    <div className="space-y-6">
      {/* Page Header Skeleton */}
      <div className="space-y-2">
        <div className="bg-muted h-8 w-48 animate-pulse rounded" />
        <div className="bg-muted h-4 w-72 animate-pulse rounded" />
      </div>

      {/* Stats Row Skeleton */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <div className="bg-muted h-4 w-20 animate-pulse rounded" />
            </CardHeader>
            <CardContent>
              <div className="bg-muted h-8 w-16 animate-pulse rounded" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table Skeleton */}
      <Card>
        <CardHeader>
          <div className="bg-muted h-6 w-32 animate-pulse rounded" />
          <div className="bg-muted h-4 w-56 animate-pulse rounded" />
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="bg-muted h-10 w-10 animate-pulse rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="bg-muted h-4 w-40 animate-pulse rounded" />
                <div className="bg-muted h-3 w-56 animate-pulse rounded" />
              </div>
              <div className="bg-muted h-6 w-16 animate-pulse rounded" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
