'use client';

/**
 * Global config-health banner — the persistent CRITICAL-only strip in the admin layout.
 *
 * Client component: renders the `global` variant of {@link ConfigHealthBanner}, which shows only
 * when a critical setting is missing. The dashboard card is the detailed surface, so the strip is
 * not shown on the overview.
 *
 * When it loads: on admin navigation, but at most once a minute. The provider check reads
 * database rows an admin can fix without a redeploy, so loading only once would leave a fixed
 * problem on screen until a reload. Loading on every navigation would spend the `admin`
 * rate-limit budget the admin pages themselves need, and run every check (and a fork's credential
 * resolver) per click. A report under {@link REPORT_MAX_AGE_MS} old is reused instead.
 *
 * A failed load clears the strip rather than keep showing an earlier answer, and is logged.
 *
 * The cost, accepted: a problem fixed in the admin can stay on the strip for up to a minute.
 */

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { ConfigHealthBanner } from '@/components/admin/config-health-banner';
import type { ConfigHealthReport } from '@/lib/config-health/types';

/** The overview shows the full card, so the strip would repeat it there. */
const OVERVIEW_PATH = '/admin/overview';

/** How long a loaded report is reused across navigations. */
export const REPORT_MAX_AGE_MS = 60_000;

/** The last report loaded in this tab, shared across the layout's remounts. */
let lastLoad: { report: ConfigHealthReport; at: number } | null = null;

/**
 * The load in flight, shared by every navigation that starts before it
 * settles: one request, and an older response can never overwrite a newer one.
 */
let inFlight: Promise<ConfigHealthReport> | null = null;

/** Forget the cached report. Tests only. */
export function __resetConfigHealthBannerCacheForTests(): void {
  lastLoad = null;
  inFlight = null;
}

function loadReport(): Promise<ConfigHealthReport> {
  inFlight ??= apiClient
    .get<ConfigHealthReport>(API.ADMIN.CONFIG_HEALTH)
    .then((data) => {
      lastLoad = { report: data, at: Date.now() };
      return data;
    })
    .catch((err: unknown) => {
      lastLoad = null;
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function freshReport(): ConfigHealthReport | null {
  return lastLoad && Date.now() - lastLoad.at < REPORT_MAX_AGE_MS ? lastLoad.report : null;
}

export function ConfigHealthGlobalBanner() {
  const pathname = usePathname();
  const onOverview = pathname === OVERVIEW_PATH;
  const [report, setReport] = useState<ConfigHealthReport | null>(freshReport);

  useEffect(() => {
    if (onOverview) return;
    const cached = freshReport();
    if (cached) {
      setReport(cached);
      return;
    }
    let cancelled = false;
    loadReport()
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setReport(null);
        logger.error('Failed to load config health', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, onOverview]);

  if (onOverview) return null;
  return <ConfigHealthBanner report={report} variant="global" />;
}
