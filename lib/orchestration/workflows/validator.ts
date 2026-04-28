/**
 * Workflow DAG Validator
 *
 * Pure-logic structural validation of a `WorkflowDefinition`. Runs the
 * checks that Zod alone can't express:
 *
 *   - entry step exists
 *   - no duplicate step ids
 *   - every `nextSteps.targetStepId` resolves to a real step
 *   - every step is reachable from the entry (BFS)
 *   - no cycles (DFS with gray/black colouring)
 *   - `human_approval` steps carry a `prompt` config
 *   - `tool_call` steps carry a `capabilitySlug` config
 *   - `guard` steps carry a `rules` config
 *   - `evaluate` steps carry a `rubric` config
 *   - `external_call` steps carry a `url` config
 *   - `agent_call` steps carry an `agentSlug` config
 *
 * Platform-agnostic: no DB, no I/O, no Next.js imports. Consumed by:
 *
 *   - `POST /workflows/:id/validate` (route)
 *   - `POST /workflows/:id/execute`  (route, pre-flight)
 *   - Session 5.2 `OrchestrationEngine` (pre-flight)
 *   - Session 5.1b workflow editor UI (live validation)
 *
 * Errors are typed, not stringly-typed, so the UI can render them
 * structurally instead of regexing messages.
 */

import type { WorkflowDefinition } from '@/types/orchestration';

/**
 * Structured validation error.
 *
 * `code` is the machine-readable kind; UI should switch on it. `message`
 * is a human fallback. `stepId` is set when the problem is attributable
 * to a single step. `path` carries a cycle path for `CYCLE_DETECTED`.
 */
export interface WorkflowValidationError {
  code:
    | 'MISSING_ENTRY'
    | 'UNKNOWN_TARGET'
    | 'UNREACHABLE_STEP'
    | 'CYCLE_DETECTED'
    | 'DUPLICATE_STEP_ID'
    | 'MISSING_APPROVAL_PROMPT'
    | 'MISSING_CAPABILITY_SLUG'
    | 'MISSING_GUARD_RULES'
    | 'MISSING_EVALUATE_RUBRIC'
    | 'MISSING_EXTERNAL_URL'
    | 'MISSING_AGENT_SLUG'
    | 'INSUFFICIENT_ROUTE_BRANCHES';
  message: string;
  stepId?: string;
  path?: string[];
}

export interface WorkflowValidationResult {
  ok: boolean;
  errors: WorkflowValidationError[];
}

/**
 * Validate a workflow definition. Returns `{ ok, errors }`; callers
 * decide how to present failures.
 */
export function validateWorkflow(def: WorkflowDefinition): WorkflowValidationResult {
  const errors: WorkflowValidationError[] = [];

  // ---- Duplicate step ids ------------------------------------------------
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const step of def.steps) {
    if (seen.has(step.id)) duplicates.add(step.id);
    seen.add(step.id);
  }
  for (const dupId of duplicates) {
    errors.push({
      code: 'DUPLICATE_STEP_ID',
      message: `Step id "${dupId}" is used more than once`,
      stepId: dupId,
    });
  }

  // Build an id→step map from the first occurrence of each id. Later
  // checks reference this map; duplicates don't prevent them from running.
  const byId = new Map<string, (typeof def.steps)[number]>();
  for (const step of def.steps) {
    if (!byId.has(step.id)) byId.set(step.id, step);
  }

  // ---- Entry step exists -------------------------------------------------
  if (!byId.has(def.entryStepId)) {
    errors.push({
      code: 'MISSING_ENTRY',
      message: `Entry step "${def.entryStepId}" does not exist in the workflow`,
    });
  }

  // ---- Unknown edge targets ----------------------------------------------
  for (const step of def.steps) {
    for (const edge of step.nextSteps) {
      if (!byId.has(edge.targetStepId)) {
        errors.push({
          code: 'UNKNOWN_TARGET',
          message: `Step "${step.id}" points to unknown step "${edge.targetStepId}"`,
          stepId: step.id,
        });
      }
    }
  }

  // ---- Step-type config checks -------------------------------------------
  for (const step of def.steps) {
    if (step.type === 'human_approval') {
      const prompt = step.config?.prompt;
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        errors.push({
          code: 'MISSING_APPROVAL_PROMPT',
          message: `human_approval step "${step.id}" is missing a non-empty config.prompt`,
          stepId: step.id,
        });
      }
    }
    if (step.type === 'tool_call') {
      const slug = step.config?.capabilitySlug;
      if (typeof slug !== 'string' || slug.trim().length === 0) {
        errors.push({
          code: 'MISSING_CAPABILITY_SLUG',
          message: `tool_call step "${step.id}" is missing a non-empty config.capabilitySlug`,
          stepId: step.id,
        });
      }
    }
    if (step.type === 'guard') {
      const rules = step.config?.rules;
      if (typeof rules !== 'string' || rules.trim().length === 0) {
        errors.push({
          code: 'MISSING_GUARD_RULES',
          message: `guard step "${step.id}" is missing a non-empty config.rules`,
          stepId: step.id,
        });
      }
    }
    if (step.type === 'evaluate') {
      const rubric = step.config?.rubric;
      if (typeof rubric !== 'string' || rubric.trim().length === 0) {
        errors.push({
          code: 'MISSING_EVALUATE_RUBRIC',
          message: `evaluate step "${step.id}" is missing a non-empty config.rubric`,
          stepId: step.id,
        });
      }
    }
    if (step.type === 'external_call') {
      const url = step.config?.url;
      if (typeof url !== 'string' || url.trim().length === 0) {
        errors.push({
          code: 'MISSING_EXTERNAL_URL',
          message: `external_call step "${step.id}" is missing a non-empty config.url`,
          stepId: step.id,
        });
      }
    }
    if (step.type === 'agent_call') {
      const slug = step.config?.agentSlug;
      if (typeof slug !== 'string' || slug.trim().length === 0) {
        errors.push({
          code: 'MISSING_AGENT_SLUG',
          message: `agent_call step "${step.id}" is missing a non-empty config.agentSlug`,
          stepId: step.id,
        });
      }
    }
    if (step.type === 'route') {
      const routes = step.config?.routes;
      if (!Array.isArray(routes) || routes.length < 2) {
        errors.push({
          code: 'INSUFFICIENT_ROUTE_BRANCHES',
          message: `route step "${step.id}" needs at least two branches`,
          stepId: step.id,
        });
      }
    }
  }

  // If the entry is missing there's nothing sensible to traverse — skip the
  // reachability and cycle checks so we don't emit cascade errors.
  const entry = byId.get(def.entryStepId);
  if (!entry) {
    return { ok: errors.length === 0, errors };
  }

  // ---- Reachability (BFS from entry) -------------------------------------
  const reachable = new Set<string>();
  const queue: string[] = [entry.id];
  reachable.add(entry.id);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const node = byId.get(current);
    if (!node) continue;
    for (const edge of node.nextSteps) {
      if (!byId.has(edge.targetStepId)) continue; // already reported as UNKNOWN_TARGET
      if (!reachable.has(edge.targetStepId)) {
        reachable.add(edge.targetStepId);
        queue.push(edge.targetStepId);
      }
    }
  }
  for (const step of def.steps) {
    if (!reachable.has(step.id)) {
      errors.push({
        code: 'UNREACHABLE_STEP',
        message: `Step "${step.id}" is not reachable from entry "${def.entryStepId}"`,
        stepId: step.id,
      });
    }
  }

  // ---- Cycle detection (DFS with gray/black colouring) ------------------
  // Only walks reachable nodes — unreachable cycles are irrelevant to the
  // executor because they'll never run.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const id of reachable) colour.set(id, WHITE);

  const reportedCycles = new Set<string>();

  const visit = (stepId: string, stack: string[]): void => {
    colour.set(stepId, GRAY);
    stack.push(stepId);
    const node = byId.get(stepId);
    if (node) {
      for (const edge of node.nextSteps) {
        const target = edge.targetStepId;
        if (!byId.has(target)) continue;
        const c = colour.get(target) ?? WHITE;
        if (c === GRAY) {
          // Found a back-edge → extract the cycle path.
          const cycleStart = stack.indexOf(target);
          const cyclePath = cycleStart >= 0 ? [...stack.slice(cycleStart), target] : [target];
          const signature = cyclePath.join('→');
          if (!reportedCycles.has(signature)) {
            reportedCycles.add(signature);
            errors.push({
              code: 'CYCLE_DETECTED',
              message: `Cycle detected: ${cyclePath.join(' → ')}`,
              stepId: target,
              path: cyclePath,
            });
          }
        } else if (c === WHITE) {
          visit(target, stack);
        }
      }
    }
    stack.pop();
    colour.set(stepId, BLACK);
  };

  for (const id of reachable) {
    if ((colour.get(id) ?? WHITE) === WHITE) {
      visit(id, []);
    }
  }

  return { ok: errors.length === 0, errors };
}
