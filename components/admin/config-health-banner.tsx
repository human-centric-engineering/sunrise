/**
 * Config-health banner — surfaces missing operationally-critical configuration in the admin app.
 *
 * Server component (presentational, prop-driven). Two variants:
 *   - `card`   — full detail (all unmet checks, any severity). Rendered on the admin dashboard.
 *   - `global` — slim strip, CRITICAL-only. Rendered in the admin layout (via the client wrapper
 *                `config-health-global-banner.tsx`) so a critical misconfig shows on every page.
 *
 * Returns `null` when there is nothing to show. Never displays any config VALUE — the report only
 * carries presence booleans (see `lib/config-health/run.ts`).
 */

import { AlertTriangle } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type {
  ConfigHealthReport,
  ConfigHealthSeverity,
  EvaluatedConfigCheck,
} from '@/lib/config-health/types';

export interface ConfigHealthBannerProps {
  report: ConfigHealthReport | null;
  variant: 'card' | 'global';
}

/** Applicable + unmet checks, most severe first. */
function unmetChecks(report: ConfigHealthReport): EvaluatedConfigCheck[] {
  const rank: Record<ConfigHealthSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return report.checks
    .filter((c) => c.applicable && !c.present)
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

const SEVERITY_LABEL: Record<ConfigHealthSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

function SeverityBadge({ severity }: { severity: ConfigHealthSeverity }) {
  return (
    <Badge
      variant={severity === 'critical' ? 'destructive' : 'secondary'}
      className={cn(
        severity === 'warning' &&
          'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
      )}
    >
      {SEVERITY_LABEL[severity]}
    </Badge>
  );
}

export function ConfigHealthBanner({ report, variant }: ConfigHealthBannerProps) {
  if (!report) return null;
  const unmet = unmetChecks(report);
  if (unmet.length === 0) return null;

  if (variant === 'global') {
    const critical = unmet.filter((c) => c.severity === 'critical');
    if (critical.length === 0) return null;
    const summary =
      critical.length === 1
        ? critical[0].label
        : `${critical.length} critical settings (${critical.map((c) => c.label).join(', ')})`;
    return (
      <div
        role="alert"
        className="flex items-center gap-2 border-b border-red-400/60 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-semibold">Configuration required:</span> {summary} not set — some
          features are disabled. See{' '}
          <a href="/admin/overview" className="underline">
            the dashboard
          </a>{' '}
          for details.
        </span>
      </div>
    );
  }

  return (
    <Card data-testid="config-health-banner">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle
            className={cn(
              'h-4 w-4',
              report.summary.critical > 0
                ? 'text-red-600 dark:text-red-400'
                : 'text-amber-600 dark:text-amber-400'
            )}
            aria-hidden="true"
          />
          Configuration health
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {unmet.map((check) => (
            <li key={check.key} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="font-medium">{check.label}</div>
                <p className="text-muted-foreground text-xs">{check.description}</p>
                <p className="text-muted-foreground text-xs">
                  <span className="font-medium">Fix:</span> {check.remediation}
                  {check.docsPath ? (
                    <span className="text-muted-foreground/70"> · {check.docsPath}</span>
                  ) : null}
                </p>
              </div>
              <SeverityBadge severity={check.severity} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
