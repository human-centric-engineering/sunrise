'use client';

import Link from 'next/link';
import Markdown from 'react-markdown';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PatternSummary } from '@/types/orchestration';

const COMPLEXITY_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  beginner: 'default',
  intermediate: 'secondary',
  advanced: 'destructive',
};

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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {patterns.map((p) => (
        <Link
          key={p.patternNumber}
          href={`/admin/orchestration/learn/patterns/${p.patternNumber}`}
          className="group"
        >
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base leading-tight">{p.patternName}</CardTitle>
                {p.complexity && (
                  <Badge variant={COMPLEXITY_VARIANT[p.complexity.toLowerCase()] ?? 'outline'}>
                    {p.complexity}
                  </Badge>
                )}
              </div>
              {p.category && <span className="text-muted-foreground text-xs">{p.category}</span>}
            </CardHeader>
            <CardContent>
              {p.description && (
                <div className="prose prose-sm dark:prose-invert text-muted-foreground line-clamp-5 max-w-none">
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
