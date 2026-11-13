'use client';

/**
 * Global config-health banner — the persistent CRITICAL-only strip in the admin layout.
 *
 * Client component: loads the config-health report on each admin
 * navigation (the provider check reads database rows an admin can change
 * without a redeploy, so a load per page keeps the strip current) and renders the `global` variant of {@link ConfigHealthBanner}, which shows only when
 * a critical setting is missing. Fails silent — a fetch error just renders nothing (the dashboard
 * card is the detailed surface).
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

export function ConfigHealthGlobalBanner() {
  const pathname = usePathname();
  const onOverview = pathname === OVERVIEW_PATH;
  const [report, setReport] = useState<ConfigHealthReport | null>(null);

  useEffect(() => {
    if (onOverview) return;
    let cancelled = false;
    apiClient
      .get<ConfigHealthReport>(API.ADMIN.CONFIG_HEALTH)
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err: unknown) => {
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
