import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import type { RelatedPattern } from '@/lib/orchestration/utils/extract-related-patterns';

interface RelatedPatternsProps {
  patterns: RelatedPattern[];
}

export function RelatedPatterns({ patterns }: RelatedPatternsProps) {
  if (patterns.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-sm font-medium">Related:</span>
      {patterns.map((p) => (
        <Link key={p.number} href={`/admin/orchestration/learn/patterns/${p.number}`}>
          <Badge variant="outline" className="hover:bg-accent cursor-pointer">
            #{p.number}
            {p.name ? ` ${p.name}` : ''}
          </Badge>
        </Link>
      ))}
    </div>
  );
}
