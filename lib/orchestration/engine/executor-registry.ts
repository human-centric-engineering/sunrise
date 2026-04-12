/**
 * BE-only step executor registry.
 *
 * Maps `WorkflowStepType` strings to an async `StepExecutor` function.
 * Executors self-register at module import via the barrel at
 * `./executors/index.ts` — adding a new pattern is a matter of writing
 * a new file and adding it to the barrel.
 *
 * This registry is **separate** from the FE-facing `step-registry.ts`
 * in the same directory, which imports `lucide-react` icons for the
 * builder palette. That file cannot be used from backend code; this
 * one cannot be used from the builder UI. A parity unit test asserts
 * the two registries cover the exact same set of step types.
 *
 * Platform-agnostic: no Next.js, no UI, no DB imports at this level.
 */

import type { StepResult, WorkflowStep, WorkflowStepType } from '@/types/orchestration';
import type { ExecutionContext } from './context';

/**
 * A step executor. Receives the step definition and a snapshot of the
 * execution context and returns a `StepResult`. The engine is
 * responsible for wrapping this in retry/timeout/budget logic.
 */
export type StepExecutor = (
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
) => Promise<StepResult>;

const registry = new Map<WorkflowStepType, StepExecutor>();

/**
 * Register an executor for a step type. Re-registering overrides the
 * previous entry — useful in tests for swapping in mocks.
 */
export function registerStepType(type: WorkflowStepType, executor: StepExecutor): void {
  registry.set(type, executor);
}

/**
 * Look up an executor by step type. Throws if the type has no
 * registered executor — the validator should catch unknown types
 * before the engine ever reaches this point.
 */
export function getExecutor(type: WorkflowStepType): StepExecutor {
  const executor = registry.get(type);
  if (!executor) {
    throw new Error(`No executor registered for step type "${type}"`);
  }
  return executor;
}

/**
 * Inspect the registered step types. Primarily used by the parity test.
 */
export function getRegisteredTypes(): readonly WorkflowStepType[] {
  return Array.from(registry.keys());
}

/**
 * Reset the registry. Test-only helper — production code should never
 * call this.
 */
export function __resetRegistryForTests(): void {
  registry.clear();
}
