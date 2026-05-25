/**
 * /admin/orchestration/evaluations/runs/new
 *
 * Shell page for the run-creation form. Loads the option lists
 * (agents, datasets, heuristic graders, judge agents) server-side and
 * hands them to the client form.
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
  RunCreateForm,
} from '@/components/admin/orchestration/evaluations-foundations/run-create-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'New run · AI Orchestration',
  description: 'Queue a batch evaluation run.',
};

async function loadAgents(): Promise<AgentOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100&kind=chat`);
    if (!res.ok) return [];
    const parsed = await parseApiResponse<Array<{ id: string; name: string; slug: string }>>(res);
    if (!parsed.success) return [];
    return parsed.data;
  } catch (err) {
    logger.error('Failed to load agents for run-create', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function loadDatasets(): Promise<DatasetOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.EVAL_DATASETS}?limit=100`);
    if (!res.ok) return [];
    const parsed =
      await parseApiResponse<Array<{ id: string; name: string; caseCount: number }>>(res);
    if (!parsed.success) return [];
    return parsed.data;
  } catch (err) {
    logger.error('Failed to load datasets for run-create', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

interface GradersResponse {
  heuristicGraders: HeuristicGraderOption[];
  judgeAgents: JudgeAgentOption[];
}

async function loadGraders(): Promise<GradersResponse> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.EVAL_GRADERS);
    if (!res.ok) return { heuristicGraders: [], judgeAgents: [] };
    const parsed = await parseApiResponse<GradersResponse>(res);
    if (!parsed.success) return { heuristicGraders: [], judgeAgents: [] };
    return parsed.data;
  } catch (err) {
    logger.error('Failed to load graders for run-create', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { heuristicGraders: [], judgeAgents: [] };
  }
}

export default async function NewRunPage(): Promise<React.ReactElement> {
  const [agents, datasets, graders] = await Promise.all([
    loadAgents(),
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
          Pair a dataset with an agent and one or more graders. The worker drains it on the next
          maintenance tick.
        </p>
      </div>

      <RunCreateForm
        agents={agents}
        datasets={datasets}
        heuristicGraders={graders.heuristicGraders}
        judgeAgents={graders.judgeAgents}
      />
    </div>
  );
}
