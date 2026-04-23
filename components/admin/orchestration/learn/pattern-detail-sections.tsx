'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import type { AiKnowledgeChunk } from '@/types/orchestration';

import { PatternContent } from '@/components/admin/orchestration/learn/pattern-content';

function stripEmbeddingPrefix(content: string): string {
  const withDash = content.match(/^.+ — .+\n\n([\s\S]*)$/);
  if (withDash) return withDash[1];
  const plain = content.match(/^[^\n]+\n\n([\s\S]*)$/);
  if (plain) return plain[1];
  return content;
}

interface PatternDetailSectionsProps {
  chunks: AiKnowledgeChunk[];
}

export function PatternDetailSections({ chunks }: PatternDetailSectionsProps) {
  return (
    <Accordion type="multiple" defaultValue={[chunks[0]?.id ?? '']}>
      {chunks.map((chunk) => (
        <AccordionItem key={chunk.id} value={chunk.id} className="border-b-0">
          <div className="bg-card mb-3 rounded-lg border">
            <AccordionTrigger className="px-6 py-4 text-base font-medium hover:no-underline">
              {(chunk.section ?? 'Details').replace(/_/g, ' ')}
            </AccordionTrigger>
            <AccordionContent className="px-6 pb-4">
              <PatternContent content={stripEmbeddingPrefix(chunk.content)} />
            </AccordionContent>
          </div>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
