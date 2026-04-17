/**
 * Template Variable Scanner
 *
 * Extracts `{{input}}` and `{{input.key}}` template references from
 * workflow step configs. Used by the dry-run endpoint to check whether
 * provided `inputData` covers all variables a workflow expects.
 *
 * Pure function — no DB, no I/O. Matches the interpolation syntax used
 * by `llm-runner.ts`'s `interpolatePrompt()`.
 */

import type { WorkflowDefinition } from '@/types/orchestration';

/** Matches `{{input}}` or `{{input.someKey}}` */
const INPUT_TEMPLATE_RE = /\{\{input(?:\.(\w+))?\}\}/g;

/**
 * Extract all unique `{{input.key}}` variable names from a workflow
 * definition. Also detects bare `{{input}}` (the entire inputData object).
 *
 * Walks every step's `config` values recursively (strings, nested
 * objects, arrays). Returns a deduplicated, sorted array.
 *
 * Special entry `"__whole__"` indicates `{{input}}` was found (the
 * step uses the entire inputData blob, not a specific key).
 */
export function extractTemplateVariables(def: WorkflowDefinition): string[] {
  const variables = new Set<string>();

  for (const step of def.steps) {
    if (step.config) {
      walkValue(step.config, variables);
    }
  }

  return [...variables].sort();
}

/** Recursively walk a value and collect input template variables. */
function walkValue(value: unknown, variables: Set<string>): void {
  if (typeof value === 'string') {
    let match: RegExpExecArray | null;
    INPUT_TEMPLATE_RE.lastIndex = 0;
    while ((match = INPUT_TEMPLATE_RE.exec(value)) !== null) {
      // match[1] is the key after "input." or undefined for bare {{input}}
      variables.add(match[1] ?? '__whole__');
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkValue(item, variables);
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) {
      walkValue(v, variables);
    }
  }
}
