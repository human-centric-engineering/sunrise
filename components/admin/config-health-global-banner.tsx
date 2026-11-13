'use client';

/**
 * Global config-health banner — the persistent CRITICAL-only strip in the admin layout.
 *
 * Client component: fetches the config-health report once on mount (config is static per deploy, so
 * no polling) and renders the `global` variant of {@link ConfigHealthBanner}, which shows only when
 * a critical setting is missing. Fails silent — a fetch error just renders nothing (the dashboard
 * card is the detailed surface).
 */

import { useEffect, useState } from 'react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { ConfigHealthBanner } from '@/components/admin/config-health-banner';
import type { ConfigHealthReport } from '@/lib/config-health/types';

export function ConfigHealthGlobalBanner() {
  const [report, setReport] = useState<ConfigHealthReport | null>(null);

  useEffect(() => {
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
  }, []);

  return <ConfigHealthBanner report={report} variant="global" />;
}
