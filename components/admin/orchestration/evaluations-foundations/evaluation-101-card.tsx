/**
 * Evaluation 101 card.
 *
 * Empty-state explainer for the dataset and run list pages. Reuses the
 * SetupRequiredBanner pattern (Card + accent border) so it visually
 * registers as guidance rather than as a hard prompt.
 *
 * Tone is locked in `help-text.ts`. Three sections — Datasets,
 * Graders, Runs — each ~120 words, each with one concrete next action.
 * No marketing prose, no "learn more"; the goal is to orient a
 * newcomer to prompt evaluation in under two minutes of reading.
 */

import * as React from 'react';
import Link from 'next/link';
import { Database, ListChecks, Play, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { evaluation101 } from '@/components/admin/orchestration/evaluations-foundations/help-text';

interface Evaluation101CardProps {
  /** Hide the section the caller is currently on (its CTA would be a no-op). */
  hideSection?: 'datasets' | 'runs';
}

export function Evaluation101Card({ hideSection }: Evaluation101CardProps): React.ReactElement {
  return (
    <Card className="border-primary/30 bg-primary/5 dark:bg-primary/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" aria-hidden />
          {evaluation101.headline}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-muted-foreground text-sm">{evaluation101.intro}</p>

        {hideSection !== 'datasets' && (
          <div className="space-y-1.5">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Database className="h-4 w-4" aria-hidden />
              {evaluation101.datasetsHeading}
            </h3>
            <p className="text-muted-foreground text-sm">{evaluation101.datasetsBody}</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/orchestration/evaluations/datasets/new">
                {evaluation101.datasetsCta}
              </Link>
            </Button>
          </div>
        )}

        <div className="space-y-1.5">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ListChecks className="h-4 w-4" aria-hidden />
            {evaluation101.gradersHeading}
          </h3>
          <p className="text-muted-foreground text-sm">{evaluation101.gradersBody}</p>
        </div>

        {hideSection !== 'runs' && (
          <div className="space-y-1.5">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Play className="h-4 w-4" aria-hidden />
              {evaluation101.runsHeading}
            </h3>
            <p className="text-muted-foreground text-sm">{evaluation101.runsBody}</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/orchestration/evaluations/runs/new">{evaluation101.runsCta}</Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
