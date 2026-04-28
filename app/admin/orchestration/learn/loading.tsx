/**
 * Learn Page Loading Skeleton
 *
 * Shown while the learn hub page fetches pattern data from the API.
 * Mirrors the page layout: breadcrumb, heading, tab bar, card grid.
 */

import { Card, CardContent, CardHeader } from '@/components/ui/card';

export default function LearnLoading() {
  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="space-y-1">
        <div className="bg-muted h-3 w-40 animate-pulse rounded" />
        <div className="bg-muted h-7 w-32 animate-pulse rounded" />
        <div className="bg-muted h-4 w-80 animate-pulse rounded" />
      </div>

      {/* Tab bar */}
      <div className="flex gap-2">
        {['Patterns', 'Advisor', 'Quiz'].map((tab) => (
          <div key={tab} className="bg-muted h-9 w-20 animate-pulse rounded-md" />
        ))}
      </div>

      {/* Card grid (3 columns) */}
      <div className="grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Card key={i} className="flex h-full flex-col">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div className="bg-muted h-5 w-36 animate-pulse rounded" />
                <div className="bg-muted h-5 w-8 animate-pulse rounded" />
              </div>
              <div className="bg-muted mt-1 h-3 w-20 animate-pulse rounded" />
            </CardHeader>
            <CardContent className="flex-1 space-y-2">
              <div className="bg-muted h-3 w-full animate-pulse rounded" />
              <div className="bg-muted h-3 w-4/5 animate-pulse rounded" />
              <div className="bg-muted h-3 w-3/5 animate-pulse rounded" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
