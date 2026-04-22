'use client';

/**
 * TemplateBanner — displayed at the top of the workflow builder when
 * the workflow being edited was created from a built-in template.
 *
 * Reads template metadata (patterns, flow summary, use cases) from
 * the `AiWorkflow.metadata` JSON column, populated by the 004 seed.
 */

import { BookOpen, ChevronDown, ChevronUp, DollarSign } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import type { WorkflowDefinition, WorkflowTemplateMetadata } from '@/types/orchestration';

export interface TemplateBannerProps {
  /** The name of the template workflow. */
  name: string;
  /** The description of the template workflow. */
  description: string;
  /** Whether the workflow is flagged as a template in the database. */
  isTemplate: boolean;
  /** Template metadata from the workflow's metadata JSON column. */
  metadata: WorkflowTemplateMetadata | null;
  /** The workflow definition — used to estimate cost per run. */
  workflowDefinition?: WorkflowDefinition | null;
}

/**
 * Step types that involve an LLM call and thus incur token costs.
 * Used to produce a rough cost-per-run estimate on the template banner.
 */
const LLM_STEP_TYPES = new Set([
  'llm_call',
  'chain',
  'reflect',
  'evaluate',
  'plan',
  'route',
  'agent_call',
]);

/**
 * Rough cost estimate per LLM step by tier assumption.
 * These are mid-range estimates assuming ~1,500 input + ~500 output tokens per step.
 */
const COST_PER_STEP_USD = {
  budget: 0.002,
  mid: 0.01,
  frontier: 0.05,
};

function estimateWorkflowCost(def: WorkflowDefinition | null | undefined): string | null {
  if (!def || !def.steps || def.steps.length === 0) return null;
  const llmSteps = def.steps.filter((s) => LLM_STEP_TYPES.has(s.type));
  if (llmSteps.length === 0) return null;

  const lowEnd = llmSteps.length * COST_PER_STEP_USD.budget;
  const highEnd = llmSteps.length * COST_PER_STEP_USD.frontier;

  const formatCost = (v: number) => {
    if (v < 0.01) return `$${v.toFixed(4)}`;
    if (v < 1) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
  };

  return `${formatCost(lowEnd)}–${formatCost(highEnd)}`;
}

export function TemplateBanner({
  name,
  description,
  isTemplate,
  metadata,
  workflowDefinition,
}: TemplateBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const costEstimate = estimateWorkflowCost(workflowDefinition);

  if (!isTemplate || !metadata) return null;

  return (
    <div className="border-b border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/40">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-blue-900 dark:text-blue-100">{name}</span>
              <Badge
                variant="secondary"
                className="bg-blue-100 px-1.5 py-0 text-[11px] leading-5 text-blue-600 dark:bg-blue-900/60 dark:text-blue-300"
              >
                Template
              </Badge>
              {costEstimate && (
                <Tip label="Estimated cost per run based on LLM step count. Range shows budget-tier to frontier-tier pricing. Actual cost depends on context length and model selection.">
                  <Badge
                    variant="outline"
                    className="gap-1 px-1.5 py-0 text-[11px] leading-5 text-emerald-700 dark:text-emerald-300"
                  >
                    <DollarSign className="h-3 w-3" />
                    {costEstimate}/run
                  </Badge>
                </Tip>
              )}
            </div>
            <p className="mt-0.5 text-sm text-blue-600/80 dark:text-blue-300/70">{description}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-0.5 h-7 shrink-0 text-blue-700 hover:bg-blue-100 hover:text-blue-900 dark:text-blue-300 dark:hover:bg-blue-900/50 dark:hover:text-blue-100"
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
