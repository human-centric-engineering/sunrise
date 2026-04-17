'use client';

/**
 * TemplateBanner — displayed at the top of the workflow builder when
 * the workflow being edited was created from a built-in template.
 *
 * Reads template metadata (patterns, flow summary, use cases) from
 * the `AiWorkflow.metadata` JSON column, populated by the 004 seed.
 */

import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { WorkflowTemplateMetadata } from '@/types/orchestration';

export interface TemplateBannerProps {
  /** The name of the template workflow. */
  name: string;
  /** The description of the template workflow. */
  description: string;
  /** Whether the workflow is flagged as a template in the database. */
  isTemplate: boolean;
  /** Template metadata from the workflow's metadata JSON column. */
  metadata: WorkflowTemplateMetadata | null;
}

export function TemplateBanner({ name, description, isTemplate, metadata }: TemplateBannerProps) {
  const [expanded, setExpanded] = useState(false);

  if (!isTemplate || !metadata) return null;

  return (
    <div className="border-b border-blue-200 bg-blue-50 px-4 py-2.5 dark:border-blue-900 dark:bg-blue-950/40">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <BookOpen className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <span className="font-medium text-blue-900 dark:text-blue-100">Built-in template:</span>
          <span className="text-blue-800 dark:text-blue-200">{name}</span>
          <span className="text-blue-600/80 dark:text-blue-300/70">{description}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          className="h-7 shrink-0 text-blue-700 hover:bg-blue-100 hover:text-blue-900 dark:text-blue-300 dark:hover:bg-blue-900/50 dark:hover:text-blue-100"
        >
          {expanded ? (
            <>
              Less <ChevronUp className="ml-1 h-3.5 w-3.5" />
            </>
          ) : (
            <>
              More <ChevronDown className="ml-1 h-3.5 w-3.5" />
            </>
          )}
        </Button>
      </div>

      {expanded && (
        <div className="mt-2.5 space-y-3 text-sm text-blue-900 dark:text-blue-100">
          <div className="flex flex-wrap gap-1.5">
            {metadata.patterns.map((pattern) => (
              <Badge
                key={pattern.number}
                variant="secondary"
                className="bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200"
              >
                #{pattern.number} {pattern.name}
              </Badge>
            ))}
          </div>

          <div>
            <p className="mb-1 text-xs font-semibold tracking-wide text-blue-700/70 uppercase dark:text-blue-400/70">
              Flow
            </p>
            <p className="leading-relaxed">{metadata.flowSummary}</p>
          </div>

          {metadata.useCases.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold tracking-wide text-blue-700/70 uppercase dark:text-blue-400/70">
                Use cases
              </p>
              <ul className="space-y-1">
                {metadata.useCases.map((uc) => (
                  <li key={uc.title}>
                    <span className="font-medium">{uc.title}</span>
                    <span className="text-blue-700 dark:text-blue-300"> &mdash; {uc.scenario}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
