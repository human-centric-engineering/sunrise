/**
 * Recent errors panel (Phase 7 Session 7.2)
 *
 * Server component. Displays the last 5 failed workflow executions
 * with truncated error messages and links to the detail page.
 */

import Link from 'next/link';
import { AlertCircle, Clock } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface RecentError {
  id: string;
  errorMessage: string | null;
  workflowId: string;
  createdAt: string;
}

export interface RecentErrorsPanelProps {
  errors: RecentError[] | null;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function RecentErrorsPanel({ errors }: RecentErrorsPanelProps) {
  const display = errors ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Recent Errors</CardTitle>
      </CardHeader>
      <CardContent>
        {display.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Clock className="h-4 w-4" aria-hidden="true" />
            <span>No recent errors</span>
          </div>
        ) : (
          <ul className="divide-y text-sm">
            {display.map((err) => (
              <li key={err.id} className="flex items-start gap-2 py-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/admin/orchestration/executions/${err.id}`}
                    className="font-medium hover:underline"
                  >
                    {err.id.slice(0, 8)}…
                  </Link>
                  <p className="text-muted-foreground truncate text-xs">
                    {err.errorMessage ?? 'Unknown error'}
                  </p>
                </div>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {formatTimestamp(err.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
