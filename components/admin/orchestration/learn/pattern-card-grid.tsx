'use client';

import Link from 'next/link';
import Markdown from 'react-markdown';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PatternSummary } from '@/types/orchestration';

interface PatternCardGridProps {
  patterns: PatternSummary[];
}

export function PatternCardGrid({ patterns }: PatternCardGridProps) {
  if (patterns.length === 0) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
        <p className="text-sm">No patterns found.</p>
        <p className="mt-1 text-xs">Seed the knowledge base to load agentic design patterns.</p>
      </div>
    );
  }

  return (
    <div className="grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {patterns.map((p) => (
        <Link
          key={p.patternNumber}
          href={`/admin/orchestration/learn/patterns/${p.patternNumber}`}
          className="group"
        >
          <Card className="flex h-full flex-col transition-shadow group-hover:shadow-md">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base leading-tight">{p.patternName}</CardTitle>
                <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                  {p.patternNumber}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex-1">
              {p.description && (
                <div className="prose prose-sm dark:prose-invert text-muted-foreground max-w-none">
                  <Markdown>{p.description}</Markdown>
                </div>
              )}
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
