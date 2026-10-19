/**
 * /admin/orchestration/evaluations/runs/new
 *
 * Shell page for the run-creation form. Loads the option lists
 * (agents, datasets, heuristic graders, judge agents) server-side and
 * hands them to the client form.
 *
 * Every list is main data: the form reads an empty one as "none exist" and
 * tells the admin to create one, so a failed load throws to the error
 * boundary instead (#518).
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  type AgentOption,
  type DatasetOption,
  type HeuristicGraderOption,
  type JudgeAgentOption,
  type WorkflowOption,
  RunCreateForm,
} from '@/components/admin/orchestration/evaluations-foundations/run-create-form';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';

export const metadata: Metadata = {
  title: 'New run · AI Orchestration',
  description: 'Queue a batch evaluation run.',
};

async function loadAgents(): Promise<AgentOption[]> {
  const { data } = await requireServerData<Array<{ id: string; name: string; slug: string }>>(
    `${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100&kind=chat`
  );
  return data;
}

async function loadDatasets(): Promise<DatasetOption[]> {
  const { data } = await requireServerData<Array<{ id: string; name: string; caseCount: number }>>(
    `${API.ADMIN.ORCHESTRATION.EVAL_DATASETS}?limit=100`
  );
  return data;
}

interface RawWorkflowListItem {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  publishedVersion: {
    id: string;
    version: number;
    snapshot: unknown;
  } | null;
}

interface RawWorkflowStep {
  id: string;
  name?: unknown;
  type?: unknown;
}

interface RawWorkflowDefinition {
  steps?: unknown;
}

function extractSteps(definition: unknown): Array<{ id: string; name: string; type: string }> {
  if (!definition || typeof definition !== 'object') return [];
  const steps = (definition as RawWorkflowDefinition).steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const step = raw as RawWorkflowStep;
    if (typeof step.id !== 'string' || step.id.length === 0) return [];
    return [
      {
        id: step.id,
        name: typeof step.name === 'string' && step.name.length > 0 ? step.name : step.id,
        type: typeof step.type === 'string' ? step.type : 'unknown',
      },
    ];
  });
}

async function loadWorkflows(): Promise<WorkflowOption[]> {
  // Only workflows that are runnable as eval subjects: active + has a
  // published version. Filtering at the API layer keeps the picker
  // honest — a draft-only workflow can't be a subject.
  const { data } = await requireServerData<RawWorkflowListItem[]>(
    `${API.ADMIN.ORCHESTRATION.WORKFLOWS}?limit=100&isActive=true`
  );
  return data
    .filter((w) => w.publishedVersion !== null)
    .map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      steps: extractSteps(w.publishedVersion?.snapshot),
    }));
}

interface GradersResponse {
  heuristicGraders: HeuristicGraderOption[];
  judgeAgents: JudgeAgentOption[];
}

async function loadGraders(): Promise<GradersResponse> {
  const { data } = await requireServerData<GradersResponse>(API.ADMIN.ORCHESTRATION.EVAL_GRADERS);
  return data;
}

export default async function NewRunPage(): Promise<React.ReactElement> {
  const [agents, workflows, datasets, graders] = await Promise.all([
    loadAgents(),
    loadWorkflows(),
    loadDatasets(),
    loadGraders(),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/admin/orchestration/evaluations/runs">
            <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
            Batch runs
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New batch run</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Pair a dataset with an agent or workflow and one or more graders. The worker drains it on
          the next maintenance tick.
        </p>
      </div>

      <RunCreateForm
        agents={agents}
        workflows={workflows}
        datasets={datasets}
        heuristicGraders={graders.heuristicGraders}
        judgeAgents={graders.judgeAgents}
      />
    </div>
  );
}
