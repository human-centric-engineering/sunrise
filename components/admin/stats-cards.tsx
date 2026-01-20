'use client';

/**
 * Stats Cards Component (Phase 4.4)
 *
 * Displays key statistics in card format for the admin dashboard.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, UserCheck, UserPlus, Shield } from 'lucide-react';
import type { SystemStats } from '@/types/admin';

interface StatsCardsProps {
  stats: SystemStats | null;
  isLoading?: boolean;
}

/**
 * Stats card skeleton for loading state
 */
function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="bg-muted h-4 w-24 animate-pulse rounded" />
        <div className="bg-muted h-4 w-4 animate-pulse rounded" />
      </CardHeader>
      <CardContent>
        <div className="bg-muted h-8 w-16 animate-pulse rounded" />
        <div className="bg-muted mt-1 h-3 w-32 animate-pulse rounded" />
      </CardContent>
    </Card>
  );
}

/**
 * Individual stat card
 */
interface StatCardProps {
  title: string;
  value: number | string;
  description: string;
  icon: React.ReactNode;
}

function StatCard({ title, value, description, icon }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-muted-foreground text-xs">{description}</p>
      </CardContent>
    </Card>
  );
}

export function StatsCards({ stats, isLoading }: StatsCardsProps) {
  if (isLoading || !stats) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Total Users"
        value={stats.users.total}
        description={`${stats.users.byRole.ADMIN} admins, ${stats.users.byRole.MODERATOR} moderators`}
        icon={<Users className="h-4 w-4" />}
      />
      <StatCard
        title="Verified Users"
        value={stats.users.verified}
        description={`${Math.round((stats.users.verified / (stats.users.total || 1)) * 100)}% of total users`}
        icon={<UserCheck className="h-4 w-4" />}
      />
      <StatCard
        title="New Users (24h)"
        value={stats.users.recentSignups}
        description="Signups in the last 24 hours"
        icon={<UserPlus className="h-4 w-4" />}
      />
      <StatCard
        title="Admin Users"
        value={stats.users.byRole.ADMIN}
        description={`${stats.users.byRole.USER} regular users`}
        icon={<Shield className="h-4 w-4" />}
      />
    </div>
  );
}
