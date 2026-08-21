/**
 * System Info
 *
 * The operator's answer to "what is this box running?" — the fork's app version
 * beside the Sunrise platform version it was built on, plus the Node version and
 * environment.
 *
 * Both versions come from `GET /api/v1/admin/stats` (`system`), which is behind
 * `withAdminAuth`. The version used to sit on the unauthenticated `/api/health`
 * payload and nowhere an operator could see it, so the release a deployment runs
 * was disclosed to anyone who asked and unavailable to the person who needed it
 * (#531).
 *
 * **This is not the only surface that shows it** — the MCP settings route
 * returns it and the MCP dashboard renders it in the server description. Do not
 * write down a count here; every count anyone has written in this repo has been
 * wrong. The invariant is that no *unauthenticated* surface carries it, and
 * `tests/unit/sunrise-version-disclosure.test.ts` is what checks that.
 *
 * A server component by design — the overview page already awaits the stats it
 * needs, so this adds no client bundle, no second fetch and no hydration.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Info } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import type { SystemStats } from '@/types/admin';

interface SystemInfoProps {
  /** The `system` block from `GET /api/v1/admin/stats`, or `null` if it could not be fetched. */
  stats: SystemStats | null;
}

/**
 * One label/value pair. `font-mono` because every value here is a version-ish
 * token.
 *
 * A missing value renders the word "unknown", not an empty line. `stats` is
 * typed `SystemStats`, but nothing checks that at runtime: `parseApiResponse`
 * validates the `{ success, data }` envelope and casts `data` — so a payload
 * without `sunriseVersion` type-checks all the way to here and would render a
 * label above nothing. Reachable during a rolling deploy where a new page hits
 * an old pod, and in a fork that overrides the stats route (which
 * CUSTOMIZATION.md invites). Same rule as the `stats === null` branch below:
 * broken must not look like fine.
 */
function InfoItem({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-mono text-sm">{value || 'unknown'}</p>
    </div>
  );
}

/**
 * Renders the platform/app version pair for the admin dashboard.
 *
 * When the payload is missing — or present but without its `system` block —
 * this says so rather than rendering an empty shell. A failed fetch and a
 * healthy deployment must not look the same, which is the whole reason the
 * operator is on this page.
 *
 * `stats?.system` rather than `stats`, because the same untrusted provenance
 * that justifies the per-field fallback below justifies this: `parseApiResponse`
 * validates the `{ success, data }` envelope and **casts** `data`, so a payload
 * without `system` type-checks all the way here and an unguarded
 * `stats.system.appVersion` would throw and 500 the whole page.
 */
export function SystemInfo({ stats }: SystemInfoProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Info className="h-5 w-5" />
          System Information
        </CardTitle>
      </CardHeader>
      <CardContent>
        {stats?.system ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <InfoItem label={`${BRAND.name} app`} value={stats.system.appVersion} />
            {/*
              "Sunrise platform", not "Sunrise". Upstream `BRAND.name` IS
              "Sunrise", so a bare label collides with the app row and the card
              reads "Sunrise 0.9.0 · Sunrise 0.9.0" — two identical labels over
              two identical numbers, which is exactly the question an operator
              came here to answer. The words disambiguate whether or not the
              fork has rebranded.
            */}
            <InfoItem label="Sunrise platform" value={stats.system.sunriseVersion} />
            <InfoItem label="Node" value={stats.system.nodeVersion} />
            <InfoItem label="Environment" value={stats.system.environment} />
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            System information is unavailable — the admin stats request failed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
