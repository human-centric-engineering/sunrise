'use client';

/**
 * TemplateBanner — displayed at the top of the workflow builder when
 * the workflow being edited was created from a built-in template.
 *
 * Matches `workflow.slug` against `BUILTIN_WORKFLOW_TEMPLATES` to pull
 * the full template metadata (patterns, flow summary, use cases) which
 * isn't stored in the database row.
 */

import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  BUILTIN_WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
} from '@/lib/orchestration/workflows/templates';

export interface TemplateBannerProps {
  /** The slug of the workflow — used to look up the template. */
  slug: string;
  /** Whether the workflow is flagged as a template in the database. */
  isTemplate: boolean;
}

/** Look up a built-in template by slug. Returns null if not found. */
function findTemplate(slug: string): WorkflowTemplate | null {
  return BUILTIN_WORKFLOW_TEMPLATES.find((t) => t.slug === slug) ?? null;
}

export function TemplateBanner({ slug, isTemplate }: TemplateBannerProps) {
  const [expanded, setExpanded] = useState(false);

  if (!isTemplate) return null;

  const template = findTemplate(slug);
  if (!template) return null;

  return (
    <div className="border-b border-blue-200 bg-blue-50 px-4 py-2.5 dark:border-blue-900 dark:bg-blue-950/40">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <BookOpen className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <span className="font-medium text-blue-900 dark:text-blue-100">Built-in template:</span>
          <span className="text-blue-800 dark:text-blue-200">{template.name}</span>
          <span className="text-blue-600/80 dark:text-blue-300/70">
            {template.shortDescription}
          </span>
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
            {template.patterns.map((pattern) => (
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
            <p className="leading-relaxed">{template.flowSummary}</p>
          </div>

          {template.useCases.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold tracking-wide text-blue-700/70 uppercase dark:text-blue-400/70">
                Use cases
              </p>
              <ul className="space-y-1">
                {template.useCases.map((uc) => (
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
