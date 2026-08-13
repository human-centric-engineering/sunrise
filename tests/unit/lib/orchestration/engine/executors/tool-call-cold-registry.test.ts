/**
 * Regression: a `tool_call` step must work on a COLD process (#537).
 *
 * `executors/tool-call.ts` dispatched straight into the capability registry
 * while every other dispatch path — chat, MCP, `agent_call` — called
 * `registerBuiltInCapabilities()` first. #462 made the dispatcher a
 * `globalThis` singleton so a registration in one module realm is visible from
 * all of them, but the TRIGGER stayed lazy behind module-scoped booleans: the
 * shared registry is only ever populated when something calls the initialiser.
 *
 * The three paths that do are all reached by an HTTP request. The scheduler is
 * a fourth and is not, so a server that has served nothing since boot
 * dispatches into an EMPTY handler map and the step fails `unknown_capability`
 * — naming a slug that is registered perfectly well. It is worst exactly when
 * it matters: an overnight-quiet process is precisely the one running the
 * 03:15 tick. Under load it hides.
 *
 * **Why this file is separate from `tool-call.test.ts`.** That file mocks the
 * dispatcher wholesale, so its registry is never empty and it cannot see this.
 * Neither can a spy on `registerBuiltInCapabilities` — "a function was called"
 * is not the invariant. The failure mode is an empty map, so only a lookup
 * proves it isn't one. This file therefore runs the REAL dispatcher and the
 * REAL registry against a deliberately cold singleton.
 *
 * @see lib/orchestration/engine/executors/tool-call.ts
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: { findMany: vi.fn().mockResolvedValue([]) },
    aiAgentCapability: { findMany: vi.fn().mockResolvedValue([]) },
    aiAgent: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/orchestration/engine/executor-registry', () => ({ registerStepType: vi.fn() }));

vi.mock('@/lib/orchestration/engine/dispatch-cache', () => ({
  buildIdempotencyKey: vi.fn(() => 'exec_cold:step1'),
  lookupDispatch: vi.fn().mockResolvedValue(null),
  recordDispatch: vi.fn().mockResolvedValue(true),
}));

import type { WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';

/**
 * A genuinely cold process, rebuilt per test.
 *
 * The singleton is `globalThis`-backed and `clearCache()` deliberately does
 * NOT drop the handler map (it clears the DB-backed registry, rate limiters
 * and agent bindings only — dispatcher.ts). So the cold precondition cannot be
 * restored by any public method: it needs a new instance, which means clearing
 * the `globalThis` slot and re-importing the module graph.
 *
 * Doing that per test rather than once at file scope is deliberate. An earlier
 * version imported at the top and relied on this being the first test in the
 * file — adding a case above it, or enabling `sequence.shuffle`, would have
 * broken the precondition. The precondition IS the test here, so it must not
 * depend on declaration order.
 */
async function coldProcess() {
  delete (globalThis as { sunriseCapabilityDispatcher?: unknown }).sunriseCapabilityDispatcher;
  vi.resetModules();
  const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
  const { executeToolCall } = await import('@/lib/orchestration/engine/executors/tool-call');
  return { capabilityDispatcher, executeToolCall };
}

/**
 * A built-in that is registered in code. `aiCapability.findMany` returns no
 * rows, so the DB-backed registry stays empty and the dispatch stops one step
 * AFTER the handler lookup — which is what makes the two outcomes tell the
 * fix apart without ever running a capability body:
 *
 *   no registration → `unknown_capability`   (handler map is empty)
 *   registration    → `capability_inactive`  (handler found, no active row)
 */
const BUILT_IN_SLUG = 'search_knowledge_base';

const ctx = {
  executionId: 'exec_cold',
  workflowId: 'wf_cold',
  userId: 'user_1',
  inputData: {},
  stepOutputs: {},
  variables: {},
  totalTokensUsed: 0,
  totalCostUsd: 0,
  defaultErrorStrategy: 'fail',
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
} as unknown as ExecutionContext;

const step: WorkflowStep = {
  id: 'step1',
  name: 'Cold tool call',
  type: 'tool_call',
  config: { capabilitySlug: BUILT_IN_SLUG },
  nextSteps: [],
};

describe('executeToolCall on a cold process (#537)', () => {
  it('populates the capability registry before dispatching', async () => {
    const { capabilityDispatcher, executeToolCall } = await coldProcess();

    // Precondition, asserted rather than assumed: if the map were already full
    // the rest of this test would prove nothing.
    expect(capabilityDispatcher.has(BUILT_IN_SLUG)).toBe(false);

    await expect(executeToolCall(step, ctx)).rejects.toMatchObject({
      // NOT `unknown_capability` — that is the #537 failure, and it is what
      // this line read before the executor registered.
      code: 'capability_inactive',
    });

    expect(capabilityDispatcher.has(BUILT_IN_SLUG)).toBe(true);
  });

  it('is a no-op on the second call — registration is idempotent by slug', async () => {
    const { capabilityDispatcher, executeToolCall } = await coldProcess();
    expect(capabilityDispatcher.has(BUILT_IN_SLUG)).toBe(false);

    await expect(executeToolCall(step, ctx)).rejects.toMatchObject({
      code: 'capability_inactive',
    });
    const firstInstance = capabilityDispatcher.getHandler(BUILT_IN_SLUG);

    await expect(executeToolCall(step, ctx)).rejects.toMatchObject({
      code: 'capability_inactive',
    });

    // Same object, not merely "still present": a second pass that re-ran the
    // constructors would replace every handler on every step of every
    // workflow, which is what the module-scoped boolean exists to prevent.
    expect(capabilityDispatcher.getHandler(BUILT_IN_SLUG)).toBe(firstInstance);
    expect(firstInstance).toBeDefined();
  });
});
