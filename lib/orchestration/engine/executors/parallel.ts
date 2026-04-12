/**
 * `parallel` — fan-out marker.
 *
 * Like `chain`, this is primarily a DAG-layout node. The engine's
 * walker schedules every target of `step.nextSteps` as runnable in
 * parallel; this executor simply records the fan-out and returns.
 *
 * Config:
 *   - `branches?: string[]` — informational; the real fan-out is
 *     declared via the step's `nextSteps` edges.
 *   - `timeoutMs?: number` — informational (enforced per-step by the
 *     underlying executors, not at the parallel node).
 *   - `stragglerStrategy?: 'wait-all' | 'first-success'` —
 *     informational in 5.2; `wait-all` is the only mode currently
 *     implemented by the walker.
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
