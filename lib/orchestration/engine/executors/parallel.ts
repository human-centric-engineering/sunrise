/**
 * `parallel` — fan-out marker.
 *
 * Like `chain`, this is primarily a DAG-layout node. The engine's
 * walker detects when a parallel node's `nextSteps` produce multiple
 * ready branches and executes them concurrently via Promise.allSettled.
 * This executor records the fan-out and returns immediately.
 *
 * Config:
 *   - `branches?: string[]` — informational; the real fan-out is
 *     declared via the step's `nextSteps` edges.
 *   - `timeoutMs?: number` — informational (enforced per-step by the
 *     underlying executors, not at the parallel node).
 *   - `stragglerStrategy?: 'wait-all' | 'first-success'` —
 *     `wait-all` is the implemented mode: all branches run concurrently
 *     and the engine waits for every branch to settle before proceeding.
 *     `first-success` is not yet implemented.
 *
 * Output: `{ parallel: true, branches: string[] }`.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

export function executeParallel(
  step: WorkflowStep,
  _ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const branches = step.nextSteps.map((e) => e.targetStepId);
  return Promise.resolve({
    output: { parallel: true, branches },
    tokensUsed: 0,
    costUsd: 0,
  });
}

registerStepType('parallel', executeParallel);
