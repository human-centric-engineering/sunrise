'use client';

/**
 * PatternCoverageDialog — explains how all 21 agentic design patterns
 * map to the 12 workflow builder step types, highlighting gaps where
 * dedicated step types could be added in the future.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface PatternMapping {
  number: number;
  name: string;
  coveredBy: string[];
  coverageNote: string;
  isGap: boolean;
}

const PATTERN_MAPPINGS: readonly PatternMapping[] = [
  {
    number: 1,
    name: 'Prompt Chaining',
    coveredBy: ['LLM Call', 'Chain'],
    coverageNote: 'Direct match — Chain is sequential LLM calls with validation gates.',
    isGap: false,
  },
  {
    number: 2,
    name: 'Routing',
    coveredBy: ['Route'],
    coverageNote: 'Direct match — classify input and branch to different paths.',
    isGap: false,
  },
  {
    number: 3,
    name: 'Parallelisation',
    coveredBy: ['Parallel'],
    coverageNote: 'Direct match — fan out to concurrent branches and join results.',
    isGap: false,
  },
  {
    number: 4,
    name: 'Reflection',
    coveredBy: ['Reflect'],
    coverageNote: 'Direct match — draft, critique, and revise loop.',
    isGap: false,
  },
  {
    number: 5,
    name: 'Tool Use',
    coveredBy: ['Tool Call'],
    coverageNote: 'Direct match — execute any registered capability.',
    isGap: false,
  },
  {
    number: 6,
    name: 'Planning',
    coveredBy: ['Plan'],
    coverageNote: 'Direct match — agent generates its own sub-plan before executing.',
    isGap: false,
  },
  {
    number: 7,
    name: 'Multi-Agent Collaboration',
    coveredBy: ['LLM Call', 'Plan'],
    coverageNote: 'Compose by wiring multiple LLM Call and Plan nodes together.',
    isGap: false,
  },
  {
    number: 8,
    name: 'Memory Management',
    coveredBy: [],
    coverageNote: 'Engine-level concern — context is managed outside the workflow DAG.',
    isGap: false,
  },
  {
    number: 9,
    name: 'Learning & Adaptation',
    coveredBy: [],
    coverageNote: 'Engine-level — feedback loops that span across workflow runs.',
    isGap: false,
  },
  {
    number: 10,
    name: 'State Management (MCP)',
    coveredBy: ['Tool Call'],
    coverageNote: 'MCP tools are invoked via Tool Call steps.',
    isGap: false,
  },
  {
    number: 11,
    name: 'Goal Setting & Monitoring',
    coveredBy: ['Plan', 'Route'],
    coverageNote: 'Approximate with Plan + Route for objective checks.',
    isGap: false,
  },
  {
    number: 12,
    name: 'Exception Handling & Recovery',
    coveredBy: [],
    coverageNote: 'Handled by the workflow errorStrategy property, not a discrete step.',
    isGap: false,
  },
  {
    number: 13,
    name: 'Human-in-the-Loop',
    coveredBy: ['Human Approval'],
    coverageNote: 'Direct match — pause the workflow and wait for human review.',
    isGap: false,
  },
  {
    number: 14,
    name: 'Knowledge Retrieval (RAG)',
    coveredBy: ['RAG Retrieve'],
    coverageNote: 'Direct match — search the knowledge base for relevant context.',
    isGap: false,
  },
  {
    number: 15,
    name: 'Inter-Agent Communication (A2A)',
    coveredBy: ['External Call'],
    coverageNote: 'Direct match — call external HTTP endpoints or agents.',
    isGap: false,
  },
  {
    number: 16,
    name: 'Resource-Aware Optimisation',
    coveredBy: ['Route'],
    coverageNote: 'Approximate with Route to switch model tiers by cost.',
    isGap: false,
  },
  {
    number: 17,
    name: 'Reasoning Techniques',
    coveredBy: ['LLM Call', 'Reflect'],
    coverageNote: 'Configure via prompt engineering inside LLM Call or Reflect.',
    isGap: false,
  },
  {
    number: 18,
    name: 'Guardrails & Safety',
    coveredBy: ['Guard'],
    coverageNote: 'Direct match — validate input or output against safety rules.',
    isGap: false,
  },
  {
    number: 19,
    name: 'Evaluation & Monitoring',
    coveredBy: ['Evaluate'],
    coverageNote: 'Direct match — score output quality against a rubric.',
    isGap: false,
  },
  {
    number: 20,
    name: 'Prioritisation',
    coveredBy: [],
    coverageNote: 'Meta-pattern managed at the orchestration layer, not per-step.',
    isGap: false,
  },
  {
    number: 21,
    name: 'Exploration & Discovery',
    coveredBy: ['Plan'],
    coverageNote: "Approximate with Plan's dynamic sub-step generation.",
    isGap: false,
  },
];

export interface PatternCoverageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PatternCoverageDialog({ open, onOpenChange }: PatternCoverageDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pattern Coverage</DialogTitle>
          <DialogDescription>
            How the 12 workflow step types map to all 21 agentic design patterns.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          {PATTERN_MAPPINGS.map((pattern) => (
            <div key={pattern.number} className="rounded-md border px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground font-mono text-xs">#{pattern.number}</span>
                  <span className="text-sm font-medium">{pattern.name}</span>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  {pattern.isGap ? (
                    <Badge
                      variant="outline"
                      className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400"
                    >
                      Gap
                    </Badge>
                  ) : pattern.coveredBy.length > 0 ? (
                    pattern.coveredBy.map((step) => (
                      <Badge key={step} variant="secondary" className="text-xs">
                        {step}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground text-xs">
                      Engine
                    </Badge>
                  )}
                </div>
              </div>
              <p className="text-muted-foreground mt-1 text-xs">{pattern.coverageNote}</p>
            </div>
          ))}

          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-800 dark:bg-emerald-950/40">
            <p className="text-xs font-medium text-emerald-900 dark:text-emerald-100">
              All 21 design patterns are covered by the 12 available step types, either as direct
              matches or through composition. Patterns marked &ldquo;Engine&rdquo; are handled by
              the orchestration runtime rather than individual workflow steps.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
