/**
 * Recent activity list (Phase 4 Session 4.1)
 *
 * Server component. Displays a merged, time-sorted list of the caller's
 * most recent conversations and workflow executions. Each row links to
 * the relevant detail page (targets may 404 in 4.1 — Session 4.2+ wires
 * them up).
 *
 * Rendered even when `items` is null or empty, but with an empty-state
 * card so the dashboard layout stays stable.
 */

import Link from 'next/link';
import { Clock, GitBranch, MessagesSquare } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface RecentActivityItem {
  kind: 'conversation' | 'execution';
  id: string;
  title: string;
  subtitle?: string;
  timestamp: string; // ISO date string
  href: string;
}

export interface RecentActivityListProps {
  items: RecentActivityItem[] | null;
  /** Max rows to display. Defaults to 10. */
  limit?: number;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function RecentActivityList({ items, limit = 10 }: RecentActivityListProps) {
  const display = items?.slice(0, limit) ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Recent activity</CardTitle>
      </CardHeader>
      <CardContent>
        {display.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Clock className="h-4 w-4" aria-hidden="true" />
            <span>
              No recent conversations or executions. Start by creating an agent and opening a chat.
            </span>
          </div>
        ) : (
          <ul className="divide-y text-sm">
            {display.map((item) => {
              const Icon = item.kind === 'conversation' ? MessagesSquare : GitBranch;
              return (
                <li key={`${item.kind}-${item.id}`} className="flex items-center gap-3 py-2">
                  <Icon className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <Link href={item.href} className="font-medium hover:underline">
                      {item.title}
                    </Link>
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
