'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { PatternSummary } from '@/types/orchestration';

import { PatternCardGrid } from './pattern-card-grid';

interface LearningTabsProps {
  patterns: PatternSummary[];
}

export function LearningTabs({ patterns }: LearningTabsProps) {
  return (
    <Tabs defaultValue="patterns">
      <TabsList>
        <TabsTrigger value="patterns">Patterns</TabsTrigger>
        <TabsTrigger value="advisor">Advisor</TabsTrigger>
        <TabsTrigger value="quiz">Quiz</TabsTrigger>
      </TabsList>

      <TabsContent value="patterns" className="mt-4">
        <PatternCardGrid patterns={patterns} />
      </TabsContent>

      <TabsContent value="advisor" className="mt-4">
        <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm font-medium">Pattern Advisor</p>
          <p className="mt-1 text-xs">
            Coming soon — get AI-powered guidance on which patterns fit your use case.
          </p>
        </div>
      </TabsContent>

      <TabsContent value="quiz" className="mt-4">
        <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm font-medium">Knowledge Quiz</p>
          <p className="mt-1 text-xs">
            Coming soon — test your understanding of agentic design patterns.
          </p>
        </div>
      </TabsContent>
    </Tabs>
  );
}
