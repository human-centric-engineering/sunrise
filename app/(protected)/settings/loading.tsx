/**
 * Settings Page Loading Skeleton
 *
 * Shown while the settings page is loading.
 */

import { Card, CardContent, CardHeader } from '@/components/ui/card';

export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      {/* Page Header Skeleton */}
      <div className="space-y-2">
        <div className="bg-muted h-8 w-32 animate-pulse rounded" />
        <div className="bg-muted h-4 w-64 animate-pulse rounded" />
      </div>

      {/* Tabs Skeleton */}
      <div className="bg-muted h-10 w-full animate-pulse rounded-lg" />

      {/* Content Card Skeleton */}
      <Card>
        <CardHeader>
          <div className="bg-muted h-6 w-24 animate-pulse rounded" />
          <div className="bg-muted h-4 w-48 animate-pulse rounded" />
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar Skeleton */}
          <div className="flex items-center gap-4">
            <div className="bg-muted h-20 w-20 animate-pulse rounded-full" />
            <div className="space-y-2">
              <div className="bg-muted h-4 w-32 animate-pulse rounded" />
              <div className="bg-muted h-6 w-40 animate-pulse rounded" />
            </div>
          </div>

          {/* Form Fields Skeleton */}
          <div className="bg-muted h-px w-full" />

          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <div className="bg-muted h-4 w-20 animate-pulse rounded" />
                <div className="bg-muted h-10 w-full animate-pulse rounded" />
              </div>
            ))}
          </div>

          {/* Button Skeleton */}
          <div className="bg-muted h-10 w-32 animate-pulse rounded" />
        </CardContent>
      </Card>
    </div>
  );
}
