/**
 * `orchestrator` — autonomous multi-agent orchestration step.
 *
 * A planner LLM dynamically selects which agents to invoke, delegates
 * tasks, collects results, and optionally replans — all at runtime.
 * This enables emergent, AI-driven coordination where the collaboration
 * strategy adapts to intermediate results rather than following a
 * pre-defined DAG.
 *
 * The orchestrator runs its own plan→delegate→aggregate→replan loop
 * (bounded by `maxRounds`). Each delegation reuses the existing
 * `executeAgentCall` function from `agent-call.ts`.
 *
 * Config:
 *   - `plannerPrompt: string`               (required) — system instructions for the planner
 *   - `availableAgentSlugs: string[]`        (required) — agents the planner can delegate to
 *   - `selectionMode?: 'auto' | 'all'`       (default 'auto') — planner picks vs fan-out
 *   - `maxRounds?: number`                    (default 3) — plan→delegate→replan cycles
 *   - `maxDelegationsPerRound?: number`       (default 5) — cap on agent calls per round
 *   - `modelOverride?: string`                (optional) — planner model
 *   - `temperature?: number`                  (default 0.3) — planner temperature
 *   - `timeoutMs?: number`                    (default 120000) — hard timeout
 *   - `budgetLimitUsd?: number`               (optional) — sub-budget for this step
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { StepResult, WorkflowStep } from '@/types/orchestration';
import {
  orchestratorConfigSchema,
  orchestratorPlannerResponseSchema,
} from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { runLlmCall, interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { executeAgentCall } from '@/lib/orchestration/engine/executors/agent-call';

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_MAX_DELEGATIONS_PER_ROUND = 5;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TEMPERATURE = 0.3;

/** Result of a single delegation attempt. */
interface DelegationResult {
  agentSlug: string;
  message: string;
  output: unknown;
  tokensUsed: number;
  costUsd: number;
  error?: string;
}

/** Summary of a single orchestration round. */
interface RoundResult {
  round: number;
  plannerReasoning?: string;
  delegations: DelegationResult[];
  plannerTokensUsed: number;
  plannerCostUsd: number;
}

type StopReason = 'final_answer' | 'max_rounds' | 'budget_exceeded' | 'timeout' | 'no_delegations';

/**
 * Build the planner system prompt that includes agent descriptions.
 */
function buildPlannerSystemPrompt(
  plannerPrompt: string,
  agents: Array<{ slug: string; name: string; description: string | null }>
): string {
  const agentList = agents
    .map(
      (a) => `- **${a.name}** (slug: \`${a.slug}\`): ${a.description ?? 'No description provided.'}`
    )
    .join('\n');

  return `${plannerPrompt}

## Available Agents
${agentList}

## Response Format
You MUST respond with valid JSON matching this schema:
{
  "delegations": [{ "agentSlug": "<slug>", "message": "<task for this agent>" }],
  "finalAnswer": "<optional — set this when you have a complete answer>",
  "reasoning": "<optional — explain your delegation or synthesis decisions>"
}

If you have enough information to provide a final answer, include "finalAnswer" and an empty "delegations" array.
Otherwise, delegate to one or more agents and leave "finalAnswer" absent.`;
}

/**
 * Build the user prompt for a planning round, including accumulated results.
 */
function buildRoundPrompt(input: string, previousRounds: RoundResult[]): string {
  if (previousRounds.length === 0) {
    return `Task:\n${input}`;
  }

  const roundsSummary = previousRounds
    .map((r) => {
      const delegationsSummary = r.delegations
        .map((d) => {
          if (d.error) {
            return `  - ${d.agentSlug}: ERROR — ${d.error}`;
          }
          const outputStr = typeof d.output === 'string' ? d.output : JSON.stringify(d.output);
          return `  - ${d.agentSlug}: ${outputStr.slice(0, 1000)}`;
        })
        .join('\n');
      return `Round ${r.round}:\n${delegationsSummary}`;
    })
    .join('\n\n');

  return `Task:\n${input}\n\nPrevious results:\n${roundsSummary}\n\nBased on these results, either provide a final answer or delegate further.`;
}

/**
 * Execute a single delegation to an agent via `executeAgentCall`.
 */
async function runDelegation(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>,
  agentSlug: string,
  message: string
): Promise<DelegationResult> {
  const syntheticStep: WorkflowStep = {
    id: `${step.id}_delegate_${agentSlug}`,
    name: `Delegate to ${agentSlug}`,
    type: 'agent_call',
    config: {
      agentSlug,
      message,
      maxToolIterations: 5,
    },
    nextSteps: [],
  };

  // Increment agent call depth for recursion guard
  const childCtx: ExecutionContext = {
    ...ctx,
    variables: {
      ...ctx.variables,
      agentCallDepth: ((ctx.variables.agentCallDepth as number) ?? 0) + 1,
    },
  };

  try {
    const result = await executeAgentCall(syntheticStep, childCtx);
    return {
      agentSlug,
      message,
      output: result.output,
      tokensUsed: result.tokensUsed,
      costUsd: result.costUsd,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn('orchestrator: delegation failed', {
      stepId: step.id,
      agentSlug,
      error: errorMessage,
    });
    return {
      agentSlug,
      message,
      output: null,
      tokensUsed: 0,
      costUsd: 0,
      error: errorMessage,
    };
  }
}

export async function executeOrchestrator(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = orchestratorConfigSchema.parse(step.config);

  if (!config.plannerPrompt || config.plannerPrompt.trim().length === 0) {
    throw new ExecutorError(
      step.id,
      'missing_planner_prompt',
      'orchestrator step is missing plannerPrompt',
      undefined,
      false
    );
  }

  if (!config.availableAgentSlugs || config.availableAgentSlugs.length === 0) {
    throw new ExecutorError(
      step.id,
      'no_agents_available',
      'orchestrator step has no availableAgentSlugs',
      undefined,
      false
    );
  }

  // Validate all agent slugs exist and are active
  const agents = await prisma.aiAgent.findMany({
    where: {
      slug: { in: config.availableAgentSlugs },
      isActive: true,
    },
    select: { slug: true, name: true, description: true },
  });

  const activeAgentSlugs = new Set(agents.map((a) => a.slug));
  const missingSlugs = config.availableAgentSlugs.filter((s) => !activeAgentSlugs.has(s));

  if (missingSlugs.length > 0) {
    logger.warn('orchestrator: some agents not found or inactive', {
      stepId: step.id,
      missingSlugs,
    });
  }

  if (agents.length === 0) {
    throw new ExecutorError(
      step.id,
      'no_agents_available',
      `None of the configured agents are active: ${config.availableAgentSlugs.join(', ')}`,
      undefined,
      false
    );
  }

  const maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxDelegationsPerRound = config.maxDelegationsPerRound ?? DEFAULT_MAX_DELEGATIONS_PER_ROUND;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build planner system prompt with agent descriptions
  const systemPrompt = buildPlannerSystemPrompt(config.plannerPrompt, agents);

  // Resolve input data
  const inputStr =
    typeof ctx.inputData === 'string' ? ctx.inputData : JSON.stringify(ctx.inputData);
  const interpolatedInput = interpolatePrompt(inputStr, ctx);

  // Orchestration loop
  const rounds: RoundResult[] = [];
  let totalTokensUsed = 0;
  let totalCostUsd = 0;
  let finalAnswer: string | undefined;
  let stopReason: StopReason = 'max_rounds';

  const startTime = Date.now();

  for (let round = 0; round < maxRounds; round++) {
    // Timeout check
    if (Date.now() - startTime > timeoutMs) {
      stopReason = 'timeout';
      logger.info('orchestrator: timeout reached', {
        stepId: step.id,
        round,
        elapsedMs: Date.now() - startTime,
      });
      break;
    }

    // AbortSignal check
    if (ctx.signal?.aborted) {
      stopReason = 'timeout';
      break;
    }

    // Call planner LLM
    const userPrompt = buildRoundPrompt(interpolatedInput, rounds);
    let plannerResult;
    try {
      plannerResult = await runLlmCall(ctx, {
        stepId: step.id,
        prompt: `${systemPrompt}\n\n${userPrompt}`,
        modelOverride: config.modelOverride,
        temperature: config.temperature ?? DEFAULT_TEMPERATURE,
        responseFormat: { type: 'json_object' },
      });
    } catch (err) {
      throw new ExecutorError(
        step.id,
        'planner_call_failed',
        `Planner LLM call failed in round ${round + 1}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    totalTokensUsed += plannerResult.tokensUsed;
    totalCostUsd += plannerResult.costUsd;

    // Parse planner response
    let plannerResponse;
    try {
      const parsed: unknown = JSON.parse(plannerResult.content);
      plannerResponse = orchestratorPlannerResponseSchema.parse(parsed);
    } catch (parseErr) {
      // Retry once with a clarifying prompt
      logger.warn('orchestrator: planner JSON parse failed, retrying', {
        stepId: step.id,
        round,
        content: plannerResult.content.slice(0, 200),
      });

      try {
        const retryResult = await runLlmCall(ctx, {
          stepId: step.id,
          prompt: `${systemPrompt}\n\n${userPrompt}\n\nYour previous response was not valid JSON. Please respond with ONLY valid JSON matching the required schema.`,
          modelOverride: config.modelOverride,
          temperature: config.temperature ?? DEFAULT_TEMPERATURE,
          responseFormat: { type: 'json_object' },
        });
        totalTokensUsed += retryResult.tokensUsed;
        totalCostUsd += retryResult.costUsd;

        const retryParsed: unknown = JSON.parse(retryResult.content);
        plannerResponse = orchestratorPlannerResponseSchema.parse(retryParsed);
      } catch {
        throw new ExecutorError(
          step.id,
          'planner_parse_failed',
          `Planner response is not valid JSON after retry in round ${round + 1}`,
          parseErr,
          true
        );
      }
    }

    // Check for final answer
    if (plannerResponse.finalAnswer) {
      finalAnswer = plannerResponse.finalAnswer;
      stopReason = 'final_answer';

      rounds.push({
        round: round + 1,
        plannerReasoning: plannerResponse.reasoning,
        delegations: [],
        plannerTokensUsed: plannerResult.tokensUsed,
        plannerCostUsd: plannerResult.costUsd,
      });

      logger.info('orchestrator: planner provided final answer', {
        stepId: step.id,
        round: round + 1,
        totalRounds: rounds.length,
      });
      break;
    }

    // Determine delegations
    let delegationsToRun: Array<{ agentSlug: string; message: string }>;

    if (config.selectionMode === 'all') {
      // Fan-out: delegate to all active agents
      delegationsToRun = agents.map((a) => ({
        agentSlug: a.slug,
        message: interpolatedInput,
      }));
    } else {
      // Filter delegations to only active agents
      delegationsToRun = plannerResponse.delegations
        .filter((d) => activeAgentSlugs.has(d.agentSlug))
        .slice(0, maxDelegationsPerRound);

      // Warn about unavailable agents in planner response
      const unavailable = plannerResponse.delegations.filter(
        (d) => !activeAgentSlugs.has(d.agentSlug)
      );
      if (unavailable.length > 0) {
        logger.warn('orchestrator: planner selected unavailable agents', {
          stepId: step.id,
          round: round + 1,
          unavailable: unavailable.map((d) => d.agentSlug),
        });
      }
    }

    if (delegationsToRun.length === 0) {
      stopReason = 'no_delegations';
      rounds.push({
        round: round + 1,
        plannerReasoning: plannerResponse.reasoning,
        delegations: [],
        plannerTokensUsed: plannerResult.tokensUsed,
        plannerCostUsd: plannerResult.costUsd,
      });
      break;
    }

    // Execute delegations in parallel
    logger.info('orchestrator: executing delegations', {
      stepId: step.id,
      round: round + 1,
      delegationCount: delegationsToRun.length,
      agents: delegationsToRun.map((d) => d.agentSlug),
    });

    const delegationPromises = delegationsToRun.map((d) =>
      runDelegation(step, ctx, d.agentSlug, d.message)
    );

    const delegationResults = await Promise.allSettled(delegationPromises);

    const completedDelegations: DelegationResult[] = delegationResults.map((result, i) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const errorMessage =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      return {
        agentSlug: delegationsToRun[i].agentSlug,
        message: delegationsToRun[i].message,
        output: null,
        tokensUsed: 0,
        costUsd: 0,
        error: errorMessage,
      };
    });

    // Accumulate delegation costs
    for (const d of completedDelegations) {
      totalTokensUsed += d.tokensUsed;
      totalCostUsd += d.costUsd;
    }

    rounds.push({
      round: round + 1,
      plannerReasoning: plannerResponse.reasoning,
      delegations: completedDelegations,
      plannerTokensUsed: plannerResult.tokensUsed,
      plannerCostUsd: plannerResult.costUsd,
    });

    // Budget check (step-level)
    if (config.budgetLimitUsd !== undefined && totalCostUsd > config.budgetLimitUsd) {
      stopReason = 'budget_exceeded';
      logger.info('orchestrator: step budget exceeded', {
        stepId: step.id,
        totalCostUsd,
        budgetLimitUsd: config.budgetLimitUsd,
      });
      break;
    }

    // Budget check (workflow-level)
    if (ctx.budgetLimitUsd !== undefined && ctx.totalCostUsd + totalCostUsd > ctx.budgetLimitUsd) {
      stopReason = 'budget_exceeded';
      logger.info('orchestrator: workflow budget exceeded', {
        stepId: step.id,
        totalCostUsd: ctx.totalCostUsd + totalCostUsd,
        budgetLimitUsd: ctx.budgetLimitUsd,
      });
      break;
    }
  }

  const totalDelegations = rounds.reduce((sum, r) => sum + r.delegations.length, 0);

  logger.info('orchestrator: completed', {
    stepId: step.id,
    stopReason,
    totalRounds: rounds.length,
    totalDelegations,
    totalTokensUsed,
    totalCostUsd,
  });

  return {
    output: {
      finalAnswer: finalAnswer ?? null,
      rounds,
      totalDelegations,
      stopReason,
    },
    tokensUsed: totalTokensUsed,
    costUsd: totalCostUsd,
  };
}

registerStepType('orchestrator', executeOrchestrator);
