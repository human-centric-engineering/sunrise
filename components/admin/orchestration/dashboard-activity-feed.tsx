/**
 * Dashboard activity feed — unified timeline of conversations,
 * executions, and errors.
 *
 * Server component. Merges recent activity items and recent errors
 * into a single chronological feed. Error items are visually
 * distinguished with a red icon.
 *
 * Replaces the former separate RecentActivityList and
 * RecentErrorsPanel components on the dashboard.
 */

import Link from 'next/link';
import { AlertCircle, Clock, GitBranch, MessagesSquare } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface ActivityFeedItem {
  kind: 'conversation' | 'execution' | 'error';
  id: string;
  title: string;
  subtitle?: string;
  timestamp: string; // ISO date string
  href: string;
}

export interface DashboardActivityFeedProps {
  items: ActivityFeedItem[] | null;
  /** Max rows to display. Defaults to 10. */
  limit?: number;
}

const ICON_MAP = {
  conversation: MessagesSquare,
  execution: GitBranch,
  error: AlertCircle,
} as const;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function DashboardActivityFeed({ items, limit = 10 }: DashboardActivityFeedProps) {
  const display = items?.slice(0, limit) ?? [];

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Recent activity</CardTitle>
      </CardHeader>
      <CardContent>
        {display.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Clock className="h-4 w-4" aria-hidden="true" />
            <span>No recent activity. Start by creating an agent and opening a chat.</span>
          </div>
        ) : (
          <ul className="divide-y text-sm">
            {display.map((item) => {
              const Icon = ICON_MAP[item.kind];
              const isError = item.kind === 'error';
              return (
                <li key={`${item.kind}-${item.id}`} className="flex items-center gap-3 py-2">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${isError ? 'text-red-500' : 'text-muted-foreground'}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={item.href} className="font-medium hover:underline">
                        {item.title}
                      </Link>
                      {isError && (
                        <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                          error
                        </Badge>
                      )}
                    </div>
                    {item.subtitle && (
                      <div className="text-muted-foreground truncate text-xs">{item.subtitle}</div>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatTimestamp(item.timestamp)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
