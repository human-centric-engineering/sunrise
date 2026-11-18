/**
 * OrgUsageSummary — one org's spend this month against its monthly cap
 * (§110 t-790).
 *
 * The org detail page's slice of `GET /api/v1/admin/orchestration/costs/orgs`.
 * The cap is set with `PATCH /api/v1/admin/orgs/[id]` (`settings.quotas`);
 * there is no form for it yet, so with no cap the page says so rather than
 * offering one.
 *
 * Spend is the platform's, what the cap counts. Spend on the org's own AI key
 * (§137) is shown beside it when there is any: the provider bills the org for
 * it, so the cap leaves it out.
 */

import { UtilisationBar } from '@/components/admin/orchestration/costs/per-agent-cost-table';
import { Usd } from '@/components/admin/orchestration/costs/usd';
import { FieldHelp } from '@/components/ui/field-help';
import type { OrgUsageRow } from '@/lib/orchestration/llm/cost-reports';

export interface OrgUsageSummaryProps {
  /** The UTC calendar month, `YYYY-MM`. */
  period: string;
  row: OrgUsageRow;
}

export function OrgUsageSummary({ period, row }: OrgUsageSummaryProps) {
  return (
    <div className="space-y-3" data-testid="org-usage-summary">
      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Spend ({period})</dt>
          <dd className="text-lg font-semibold">
            <Usd value={row.totalCostUsd - row.ownKeyCostUsd} />
          </dd>
          {row.ownKeyCostUsd > 0 && (
            <dd className="text-muted-foreground text-xs" data-testid="org-usage-own-key">
              Plus <Usd value={row.ownKeyCostUsd} /> on its own AI keys, billed to it by the
              provider
            </dd>
          )}
        </div>
        <div>
          <dt className="text-muted-foreground flex items-center gap-1">
            Monthly cap
            <FieldHelp title="Monthly cap">
              <p>
                The most this organisation may spend on paid AI providers in a calendar month (UTC).
                Once it is reached, its paid calls are refused until the next month; local models
                keep working. The global monthly budget still applies on top of it.
              </p>
              <p className="mt-2">
                Calls on the organisation&apos;s own AI keys are not counted and not refused: the
                provider bills the organisation for them. An agent&apos;s own monthly budget counts
                them, and stops its chat turns once reached.
              </p>
              <p className="mt-2">
                Set it from the install organisation with <code>PATCH /api/v1/admin/orgs/[id]</code>{' '}
                and <code>settings.quotas</code>.
              </p>
            </FieldHelp>
          </dt>
          <dd className="text-lg font-semibold">
            {row.monthlyBudgetUsd === null ? (
              <span className="text-muted-foreground text-sm font-normal">No cap set</span>
            ) : (
              <Usd value={row.monthlyBudgetUsd} />
            )}
            {row.monthlyBudgetUsd === 0 && (
              <span className="text-muted-foreground block text-xs font-normal">
                Paid calls off
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Calls</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {row.count.toLocaleString('en-US')}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Tokens</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {(row.inputTokens + row.outputTokens).toLocaleString('en-US')}
          </dd>
        </div>
      </dl>
      {/* A cap of 0 means "no paid calls": there is no share of it to show. */}
      {row.utilisation !== null && <UtilisationBar utilisation={row.utilisation} />}
    </div>
  );
}
