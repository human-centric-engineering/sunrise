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
      const applicable = (!check.productionOnly || isProd) && (check.applicable?.() ?? true);
      // Skip detection entirely when not applicable — treat as satisfied so it's never flagged.
      const present = applicable ? await check.detect() : true;
      return {
        key: check.key,
        label: check.label,
        severity: check.severity,
        description: check.description,
        remediation: check.remediation,
        docsPath: check.docsPath,
        present,
        applicable,
      };
    })
  );

  const unmet = checks.filter((c) => c.applicable && !c.present);
  const summary = {
    critical: unmet.filter((c) => c.severity === 'critical').length,
    warning: unmet.filter((c) => c.severity === 'warning').length,
    info: unmet.filter((c) => c.severity === 'info').length,
    ok: checks.filter((c) => c.applicable && c.present).length,
  };

  return { environment, platform, checks, summary };
}
