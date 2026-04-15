'use client';

/**
 * PatternCoverageDialog — explains how all 21 agentic design patterns
 * map to the 9 workflow builder step types, highlighting gaps where
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

type Tier = 'Foundation' | 'Intermediate' | 'Advanced';

interface PatternMapping {
  number: number;
  name: string;
  tier: Tier;
  coveredBy: string[];
  coverageNote: string;
  isGap: boolean;
}

const PATTERN_MAPPINGS: readonly PatternMapping[] = [
  // Foundation
  {
    number: 1,
    name: 'Prompt Chaining',
    tier: 'Foundation',
    coveredBy: ['LLM Call', 'Chain'],
    coverageNote: 'Direct match — Chain is sequential LLM calls with validation gates.',
    isGap: false,
  },
  {
    number: 2,
    name: 'Routing',
    tier: 'Foundation',
    coveredBy: ['Route'],
    coverageNote: 'Direct match — classify input and branch to different paths.',
    isGap: false,
  },
  {
    number: 5,
    name: 'Tool Use',
    tier: 'Foundation',
    coveredBy: ['Tool Call'],
    coverageNote: 'Direct match — execute any registered capability.',
    isGap: false,
  },
  {
    number: 14,
    name: 'Knowledge Retrieval (RAG)',
    tier: 'Foundation',
    coveredBy: ['RAG Retrieve'],
    coverageNote: 'Direct match — search the knowledge base for relevant context.',
    isGap: false,
  },
  {
    number: 18,
    name: 'Guardrails & Safety',
    tier: 'Foundation',
    coveredBy: [],
    coverageNote: 'Gap — no dedicated guard step. Currently requires LLM Call + Route workaround.',
    isGap: true,
  },
  // Intermediate
  {
    number: 3,
    name: 'Parallelisation',
    tier: 'Intermediate',
    coveredBy: ['Parallel'],
    coverageNote: 'Direct match — fan out to concurrent branches and join results.',
    isGap: false,
  },
  {
    number: 4,
    name: 'Reflection',
    tier: 'Intermediate',
    coveredBy: ['Reflect'],
    coverageNote: 'Direct match — draft, critique, and revise loop.',
    isGap: false,
  },
  {
    number: 6,
    name: 'Planning',
    tier: 'Intermediate',
    coveredBy: ['Plan'],
    coverageNote: 'Direct match — agent generates its own sub-plan before executing.',
    isGap: false,
  },
  {
    number: 7,
    name: 'Multi-Agent Collaboration',
    tier: 'Intermediate',
    coveredBy: ['LLM Call', 'Plan'],
    coverageNote: 'Compose by wiring multiple LLM Call and Plan nodes together.',
    isGap: false,
  },
  {
    number: 8,
    name: 'Memory Management',
    tier: 'Intermediate',
    coveredBy: [],
    coverageNote: 'Engine-level concern — context is managed outside the workflow DAG.',
    isGap: false,
  },
  {
    number: 13,
    name: 'Human-in-the-Loop',
    tier: 'Intermediate',
    coveredBy: ['Human Approval'],
    coverageNote: 'Direct match — pause the workflow and wait for human review.',
    isGap: false,
  },
  // Advanced
  {
    number: 9,
    name: 'Learning & Adaptation',
    tier: 'Advanced',
    coveredBy: [],
    coverageNote: 'Engine-level — feedback loops that span across workflow runs.',
    isGap: false,
  },
  {
    number: 10,
    name: 'State Management (MCP)',
    tier: 'Advanced',
    coveredBy: ['Tool Call'],
    coverageNote: 'MCP tools are invoked via Tool Call steps.',
    isGap: false,
  },
  {
    number: 11,
    name: 'Goal Setting & Monitoring',
    tier: 'Advanced',
    coveredBy: ['Plan', 'Route'],
    coverageNote: 'Approximate with Plan + Route for objective checks.',
    isGap: false,
  },
  {
    number: 12,
    name: 'Exception Handling & Recovery',
    tier: 'Advanced',
    coveredBy: [],
    coverageNote: 'Handled by the workflow errorStrategy property, not a discrete step.',
    isGap: false,
  },
  {
    number: 15,
    name: 'Inter-Agent Communication (A2A)',
    tier: 'Advanced',
    coveredBy: [],
    coverageNote: 'Gap — no step for external HTTP or agent-to-agent calls.',
    isGap: true,
  },
  {
    number: 16,
    name: 'Resource-Aware Optimisation',
    tier: 'Advanced',
    coveredBy: ['Route'],
    coverageNote: 'Approximate with Route to switch model tiers by cost.',
    isGap: false,
  },
  {
    number: 17,
    name: 'Reasoning Techniques',
    tier: 'Advanced',
    coveredBy: ['LLM Call', 'Reflect'],
    coverageNote: 'Configure via prompt engineering inside LLM Call or Reflect.',
    isGap: false,
  },
  {
    number: 19,
    name: 'Evaluation & Monitoring',
    tier: 'Advanced',
    coveredBy: ['Reflect'],
    coverageNote: 'Gap — Reflect is close but lacks dedicated scoring semantics.',
    isGap: true,
  },
  {
    number: 20,
    name: 'Prioritisation',
    tier: 'Advanced',
    coveredBy: [],
    coverageNote: 'Meta-pattern managed at the orchestration layer, not per-step.',
    isGap: false,
  },
  {
    number: 21,
    name: 'Exploration & Discovery',
    tier: 'Advanced',
    coveredBy: ['Plan'],
    coverageNote: "Approximate with Plan's dynamic sub-step generation.",
    isGap: false,
  },
];

const TIERS: readonly Tier[] = ['Foundation', 'Intermediate', 'Advanced'];

const TIER_DESCRIPTIONS: Record<Tier, string> = {
  Foundation: 'Core patterns for any agent system',
  Intermediate: 'Quality, speed, planning, and oversight',
  Advanced: 'Production hardening and autonomy',
};

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
            How the 9 workflow step types map to all 21 agentic design patterns.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {TIERS.map((tier) => {
            const patterns = PATTERN_MAPPINGS.filter((p) => p.tier === tier);
            return (
              <section key={tier}>
                <div className="mb-2">
                  <h3 className="text-sm font-semibold">{tier}</h3>
                  <p className="text-muted-foreground text-xs">{TIER_DESCRIPTIONS[tier]}</p>
                </div>
                <div className="space-y-2">
                  {patterns.map((pattern) => (
                    <div key={pattern.number} className="rounded-md border px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground font-mono text-xs">
                            #{pattern.number}
                          </span>
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
                </div>
              </section>
            );
          })}

          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/40">
            <p className="text-xs font-medium text-amber-900 dark:text-amber-100">
              3 patterns are flagged as gaps — Guardrails, Inter-Agent Communication, and
              Evaluation. These are candidates for dedicated step types in a future release.
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
