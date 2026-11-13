/**
 * Config-health runner — evaluate every registered check into a value-free {@link ConfigHealthReport}.
 *
 * Merges the platform registry with the fork's `appConfigHealthChecks`. A `productionOnly` check is
 * marked `applicable: false` outside production (so dev doesn't nag about, e.g., CRON_SECRET, which
 * dev drives via the in-process ticker); a check with an `applicable()` gate that returns false is
 * likewise skipped. Non-applicable checks are reported `present: true` so they're never flagged.
 * Server-only — reads `process.env` and (for the provider check) the DB.
 */

import { env } from '@/lib/env';
import { logger } from '@/lib/logging';
import { CONFIG_HEALTH_CHECKS } from '@/lib/config-health/checks';
import { appConfigHealthChecks } from '@/lib/app/config-health';
import type { ConfigHealthReport, EvaluatedConfigCheck } from '@/lib/config-health/types';

export async function runConfigHealthChecks(): Promise<ConfigHealthReport> {
  const environment = env.NODE_ENV;
  const platform = process.env.VERCEL ? 'vercel' : 'other';
  const isProd = environment === 'production';

  const registry = [...CONFIG_HEALTH_CHECKS, ...appConfigHealthChecks];

  const checks: EvaluatedConfigCheck[] = await Promise.all(
    registry.map(async (check) => {
      const base = {
        key: check.key,
        label: check.label,
        severity: check.severity,
        description: check.description,
        remediation: check.remediation,
        docsPath: check.docsPath,
      };
      // One check that throws (a database read, a fork's own check) must not
      // take the others down with it: the report is most needed when config
      // is broken. It is reported as not confirmed, and logged.
      try {
        const applicable = (!check.productionOnly || isProd) && (check.applicable?.() ?? true);
        // Skip detection entirely when not applicable — treat as satisfied so it's never flagged.
        const present = applicable ? await check.detect() : true;
        return { ...base, present, applicable };
      } catch (err) {
        logger.error('Config health check failed', {
          check: check.key,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ...base, present: false, applicable: true, failed: true as const };
      }
    })
  );

  // A check that could not run is not known to be missing, so it is counted
  // apart from the severities (alerting on `critical > 0` must not fire on it).
  const unmet = checks.filter((c) => c.applicable && !c.present && !c.failed);
  const summary = {
    critical: unmet.filter((c) => c.severity === 'critical').length,
    warning: unmet.filter((c) => c.severity === 'warning').length,
    info: unmet.filter((c) => c.severity === 'info').length,
    ok: checks.filter((c) => c.applicable && c.present).length,
    failed: checks.filter((c) => c.failed).length,
  };

  return { environment, platform, checks, summary };
}
