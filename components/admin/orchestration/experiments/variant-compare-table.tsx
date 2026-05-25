/**
 * VariantCompareTable — server-rendered per-metric × variant grid.
 *
 * For each metric the experiment's variants were scored on:
 *   - Each variant cell shows mean + (n) below
 *   - The control variant (index 0) is the baseline; every other
 *     variant has p-value + Cohen's d badges underneath
 *   - The metric row's winner column shows a Trophy when one variant
 *     beats the control by all three thresholds (mean direction +
 *     p < 0.05 + |d| ≥ 0.5), or "no clear winner" otherwise
 *
 * Why server-rendered: the statistical calculation is pure compute on
 * the run summary JSON we already loaded; no interactivity needed.
 * Filters and sortable columns can land later as a client extension.
 */

import { Award, AlertCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import {
  decidePairwiseWinner,
  type PairwiseWinnerResult,
} from '@/lib/orchestration/evaluations/stats/winner';

export interface CompareTableVariant {
  variantId: string;
  label: string;
  rawScores: Record<string, number[]>;
  meanByMetric: Record<string, number | null>;
  runStatus: string | null;
}

interface VariantCompareTableProps {
  variants: CompareTableVariant[];
  metricSlugs: string[];
}

const STATS_DISCLAIMER =
  "Welch's t-test assumes per-case scores are roughly normal. Rubric scores on [0, 1] often aren't — read p-values with extra caution when N is small (under ~30 per variant) or when both samples sit near 0 or 1.";

export function VariantCompareTable({
  variants,
  metricSlugs,
}: VariantCompareTableProps): React.ReactElement {
  if (variants.length < 2) {
    return (
      <Card className="text-muted-foreground p-6 text-sm">
        At least 2 variants are required for a comparison.
      </Card>
    );
  }

  const control = variants[0];
  const challengers = variants.slice(1);

  return (
    <Card className="overflow-hidden">
      <div className="border-b p-4">
        <h2 className="text-sm font-medium">
          Per-metric comparison{' '}
          <FieldHelp title="Statistical methodology">{STATS_DISCLAIMER}</FieldHelp>
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          {control.label} is the control; other variants are tested against it pairwise.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-muted-foreground border-b text-xs">
              <th className="px-4 py-2 text-left font-medium">Metric</th>
              <th className="px-4 py-2 text-left font-medium">{control.label} (control)</th>
              {challengers.map((c) => (
                <th key={c.variantId} className="px-4 py-2 text-left font-medium">
                  {c.label}
                </th>
              ))}
              <th className="px-4 py-2 text-left font-medium">Winner</th>
            </tr>
          </thead>
          <tbody>
            {metricSlugs.map((slug) => {
              const controlScores = control.rawScores[slug] ?? [];
              const decisions = challengers.map((c) =>
                decidePairwiseWinner(c.rawScores[slug] ?? [], controlScores)
              );
              const overallWinner = pickOverallWinner(control, challengers, decisions);

              return (
                <tr key={slug} className="border-b last:border-b-0">
                  <td className="px-4 py-3 font-mono text-xs">{slug}</td>
                  <td className="px-4 py-3">
                    <VariantCell mean={control.meanByMetric[slug]} n={controlScores.length} />
                  </td>
                  {challengers.map((c, i) => (
                    <td key={c.variantId} className="px-4 py-3">
                      <VariantCell
                        mean={c.meanByMetric[slug]}
                        n={(c.rawScores[slug] ?? []).length}
                        decision={decisions[i]}
                        challengerLabel={c.label}
                      />
                    </td>
                  ))}
                  <td className="px-4 py-3">
                    {overallWinner ? (
                      <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600/90">
                        <Award className="h-3 w-3" aria-hidden />
                        {overallWinner}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                        <AlertCircle className="h-3 w-3" aria-hidden />
                        no clear winner
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function pickOverallWinner(
  control: CompareTableVariant,
  challengers: CompareTableVariant[],
  decisions: PairwiseWinnerResult[]
): string | null {
  const winningChallengers: { label: string; meanDifference: number }[] = [];
  let controlBeats = false;
  for (let i = 0; i < challengers.length; i++) {
    const d = decisions[i];
    if (d.winner === 'a') {
      // 'a' is the challenger argument; challenger beats control
      winningChallengers.push({
        label: challengers[i].label,
        meanDifference: d.meanDifference ?? 0,
      });
    } else if (d.winner === 'b') {
      controlBeats = true;
    }
  }
  if (winningChallengers.length === 0) {
    return controlBeats ? `${control.label} (control)` : null;
  }
  // Multiple challengers crossed the threshold — surface the one with the
  // largest mean improvement over the control.
  winningChallengers.sort((a, b) => b.meanDifference - a.meanDifference);
  return winningChallengers[0].label;
}

function VariantCell({
  mean,
  n,
  decision,
  challengerLabel: _challengerLabel,
}: {
  mean: number | null;
  n: number;
  decision?: PairwiseWinnerResult;
  challengerLabel?: string;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="font-medium">{mean === null ? '—' : mean.toFixed(3)}</div>
      <div className="text-muted-foreground text-xs">n = {n}</div>
      {decision ? <StatBadges decision={decision} /> : null}
    </div>
  );
}

function StatBadges({ decision }: { decision: PairwiseWinnerResult }): React.ReactElement | null {
  if (decision.pValue === null || decision.effectSize === null) {
    return (
      <Badge variant="outline" className="text-[10px]">
        n &lt; 2
      </Badge>
    );
  }
  const sig = decision.pValue < 0.05;
  const meaningful = Math.abs(decision.effectSize) >= 0.5;
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant={sig ? 'default' : 'outline'} className="px-1.5 py-0 text-[10px] font-normal">
        p = {formatPValue(decision.pValue)}
      </Badge>
      <Badge
        variant={meaningful ? 'default' : 'outline'}
        className="px-1.5 py-0 text-[10px] font-normal"
      >
        d = {decision.effectSize.toFixed(2)}
      </Badge>
    </div>
  );
}

function formatPValue(p: number): string {
  if (p < 0.001) return '<0.001';
  if (p < 0.01) return p.toFixed(3);
  return p.toFixed(2);
}
