/**
 * `route` — LLM-driven branch selection.
 *
 * Config:
 *   - `classificationPrompt: string` — what to ask the router LLM.
 *   - `routes: Array<{ label: string }>` — candidate branch labels.
 *   - `modelOverride?: string`
 *   - `temperature?: number`
 *
 * The router LLM is asked to return exactly one of the declared
 * branch labels. The executor then selects the matching
 * `ConditionalEdge` from `step.nextSteps` (edges are matched by
 * `edge.condition === label`) and returns it as `nextStepIds`.
 *
 * Unknown branch labels are an `ExecutorError`.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '../context';
import { ExecutorError } from '../errors';
import { runLlmCall } from '../llm-runner';
import { registerStepType } from '../executor-registry';

interface RouteConfig {
  classificationPrompt?: string;
  routes?: Array<{ label?: unknown }>;
  modelOverride?: string;
  temperature?: number;
}

export async function executeRoute(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = step.config as RouteConfig;

  const routes = Array.isArray(config.routes) ? config.routes : [];
  const labels = routes
    .map((r) => (typeof r.label === 'string' ? r.label : ''))
    .filter((l) => l.length > 0);

  if (labels.length === 0) {
    throw new ExecutorError(step.id, 'missing_routes', 'route step has no route labels configured');
  }

  const classificationPrompt = config.classificationPrompt;
  if (typeof classificationPrompt !== 'string' || classificationPrompt.trim().length === 0) {
    throw new ExecutorError(
      step.id,
      'missing_classification_prompt',
      'route step is missing a classificationPrompt'
    );
  }

  const instruction =
    `${classificationPrompt}\n\n` +
    `Candidate labels: ${labels.join(', ')}\n` +
    `Reply with exactly one label from the list above and nothing else.\n\n` +
    `Input:\n{{input}}`;

  const result = await runLlmCall(ctx, {
    stepId: step.id,
    prompt: instruction,
    modelOverride: config.modelOverride,
    temperature: config.temperature ?? 0.1,
  });

  const chosen = result.content.trim().toLowerCase();
  const match = labels.find(
    (l) => l.toLowerCase() === chosen || chosen.startsWith(l.toLowerCase())
  );
  if (!match) {
    throw new ExecutorError(
      step.id,
      'unknown_branch',
      `Router returned unrecognized label "${result.content.slice(0, 64)}" — expected one of: ${labels.join(', ')}`
    );
  }

  const nextEdge = step.nextSteps.find((e) => e.condition === match);
  if (!nextEdge) {
    throw new ExecutorError(
      step.id,
      'missing_edge_for_branch',
      `Route selected "${match}" but no outgoing edge matches that condition`
    );
  }

  return {
    output: { branch: match, raw: result.content },
    tokensUsed: result.tokensUsed,
    costUsd: result.costUsd,
    nextStepIds: [nextEdge.targetStepId],
  };
}

registerStepType('route', executeRoute);
