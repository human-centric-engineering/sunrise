'use client';

/**
 * TestingTabs
 *
 * Client wrapper that renders Evaluations and Experiments as tabs
 * on the unified Testing page. Each tab has a FieldHelp icon beside
 * it that compares/contrasts evaluations vs experiments.
 */

import * as React from 'react';
import { ClipboardCheck, FlaskConical } from 'lucide-react';

import { FieldHelp } from '@/components/ui/field-help';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface TestingTabsProps {
  evaluationsContent: React.ReactNode;
  experimentsContent: React.ReactNode;
  defaultTab?: 'evaluations' | 'experiments';
}

export function TestingTabs({
  evaluationsContent,
  experimentsContent,
  defaultTab = 'evaluations',
}: TestingTabsProps) {
  return (
    <Tabs defaultValue={defaultTab}>
      <div className="flex items-center gap-2">
        <TabsList>
          <TabsTrigger value="evaluations" className="gap-1.5">
            <ClipboardCheck className="h-4 w-4" />
            Evaluations
          </TabsTrigger>
          <TabsTrigger value="experiments" className="gap-1.5">
            <FlaskConical className="h-4 w-4" />
            Experiments
          </TabsTrigger>
        </TabsList>
        <FieldHelp
          title="Evaluations vs Experiments"
          contentClassName="w-96 max-h-96 overflow-y-auto"
        >
          <p className="font-medium">Evaluations</p>
          <p>
            Run a live chat session with a <em>single agent</em>. You review and annotate each
            response to measure quality and identify issues.
          </p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>Check an agent handles key scenarios correctly</li>
            <li>Catch regressions after changing instructions or capabilities</li>
            <li>Build an annotated dataset of good/bad responses</li>
            <li>Generate improvement suggestions from the conversation transcript</li>
          </ul>

          <p className="mt-3 font-medium">Experiments</p>
          <p>
            A/B test 2&ndash;5 <em>variants</em> of the same agent side by side. Each variant can
            use different prompt wording, instructions, or configuration.
          </p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>Compare different prompt strategies (concise vs detailed)</li>
            <li>Test tone or style variations (formal vs casual)</li>
            <li>Measure the impact of instruction changes</li>
            <li>Pick a winner before deploying to production</li>
          </ul>

          <p className="mt-3 text-xs">
            Start with <strong>evaluations</strong> to understand your baseline, then use{' '}
            <strong>experiments</strong> to optimise.
          </p>
        </FieldHelp>
      </div>

      <TabsContent value="evaluations" className="mt-4">
        {evaluationsContent}
      </TabsContent>
      <TabsContent value="experiments" className="mt-4">
        {experimentsContent}
      </TabsContent>
    </Tabs>
  );
}
