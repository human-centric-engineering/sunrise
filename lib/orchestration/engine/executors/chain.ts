/**
 * `chain` — sequential prompt chaining.
 *
 * In the current builder, a chain node is a pass-through: its
 * `nextSteps` already encode the ordered list of sub-steps to execute
 * next. The engine walks them naturally via the DAG traversal. This
 * executor simply records the chain as visited and returns a summary;
 * the real work happens on the subsequent step nodes.
 *
 * Config:
 *   - `description?: string`
 *
 * Output: `{ chained: true }` — subsequent steps carry the actual data.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';

export function executeChain(
  _step: WorkflowStep,
  _ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  return Promise.resolve({
    output: { chained: true },
    tokensUsed: 0,
    costUsd: 0,
  });
}

registerStepType('chain', executeChain);
