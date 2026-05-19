/**
 * `guard` — safety gate that validates input against rules.
 *
 * Config:
 *   - `rules: string` — natural-language safety rules (LLM mode) or a
 *     regex pattern (regex mode). Not required for schema mode.
 *   - `mode: 'llm' | 'regex' | 'schema'` — validation approach.
 *   - `failAction: 'block' | 'flag'` — hard stop vs. annotate and continue.
 *
 *   LLM mode:
 *     - `modelOverride?`, `temperature?`, `reasoningEffort?`
 *
 *   Schema mode:
 *     - `schemaName: string` — required. Slug into the schema registry
 *       (`lib/orchestration/schemas/registry.ts`). The named Zod
 *       schema is run via `safeParse` against the resolved input.
 *     - `inputStepId?: string` — when set, validates
 *       `ctx.stepOutputs[inputStepId]`. When absent, validates
 *       `ctx.inputData` (matches regex-mode default).
 *
 *   On Zod parse failure the output carries `issues` (the array of
 *   `ZodIssue`) so a downstream retry's `__retryContext` text can name
 *   the exact field and value that failed.
 *
 * The step has two output handles. The executor resolves `nextStepIds`
 * to the edge whose `condition` matches `"pass"` or `"fail"`.
 *
 * Why schema mode exists: LLM mode is suitable for fuzzy quality
 * judgments (tone, on-topic, plausibility). Closed-set checks
 * (enum membership, required-field presence, array-of-strings-each-
 * in-allowed-list) recurrently hallucinate even with the closed set
 * pasted into the prompt. Schema mode is the deterministic fix:
 * structural shape and enum checks live in Zod, the LLM only handles
 * what it's good at.
 */

import type { StepResult, WorkflowStep } from '@/types/orchestration';
import { guardConfigSchema } from '@/lib/validations/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt, runLlmCall } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { getSchema } from '@/lib/orchestration/schemas/registry';

export async function executeGuard(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const config = guardConfigSchema.parse(step.config);

  const mode = config.mode ?? 'llm';
  const failAction = config.failAction ?? 'block';

  // `rules` is required for LLM and regex modes (carries the rule
  // text / pattern); schema mode keys off `schemaName` instead.
  if (mode !== 'schema') {
    const rules = config.rules;
    if (typeof rules !== 'string' || rules.trim().length === 0) {
      throw new ExecutorError(step.id, 'missing_rules', 'guard step is missing rules');
    }
  }

  let passed: boolean;
  let reason: string;
  let issues: unknown[] | undefined; // Zod issues; only set in schema mode on fail.
  let tokensUsed = 0;
  let costUsd = 0;

  if (mode === 'regex') {
    const rules = config.rules as string; // narrowed above
    const input = JSON.stringify(ctx.inputData);
    try {
      const re = new RegExp(rules, 'i');
      passed = re.test(input);
    } catch {
      throw new ExecutorError(step.id, 'invalid_regex', `Invalid regex pattern: ${rules}`);
    }
    reason = passed ? 'Input matches the pattern' : 'Input does not match the pattern';
  } else if (mode === 'schema') {
    // `schemaName` is required when mode is schema. The Zod refine on
    // guardConfigSchema also catches this, but we surface a typed
    // ExecutorError here so the trace entry tells operators the missing
    // field by name rather than rejecting with a generic ZodError.
    const schemaName = config.schemaName;
    if (typeof schemaName !== 'string' || schemaName.length === 0) {
      throw new ExecutorError(
        step.id,
        'missing_schema_name',
        'guard step in `mode: schema` is missing `schemaName`'
      );
    }
    const schema = getSchema(schemaName);
    if (!schema) {
      throw new ExecutorError(
        step.id,
        'schema_not_found',
        `guard step references schema "${schemaName}" which is not registered. Register it via \`registerSchema\` in a feature module loaded on app start.`
      );
    }
    // Source resolution. When `inputStepId` is set, validate that
    // step's output (the common case — schema mode is normally used
    // to validate an upstream step's structured output). When absent,
    // fall back to the workflow input — matches the regex-mode
    // default and is useful for validating the trigger payload at the
    // top of a workflow.
    const inputStepId = config.inputStepId;
    let inputValue: unknown;
    if (typeof inputStepId === 'string' && inputStepId.length > 0) {
      // Surface a typed error when the named step has not completed
      // (or doesn't exist) — silently passing `undefined` to the
      // schema would mask the wiring bug.
      if (!(inputStepId in ctx.stepOutputs)) {
        throw new ExecutorError(
          step.id,
          'input_step_not_found',
          `guard step references inputStepId "${inputStepId}" but no such step has completed before this guard. Check the DAG wiring.`
        );
      }
      inputValue = ctx.stepOutputs[inputStepId];
    } else {
      inputValue = ctx.inputData;
    }
    const parse = schema.safeParse(inputValue);
    if (parse.success) {
      passed = true;
      reason = 'Input matches the schema';
    } else {
      passed = false;
      // Capture the Zod issues array so the trace + retry context can
      // point at the exact field. `.format()` is too noisy for trace
      // output; `.issues` is the flat list authors actually need.
      issues = parse.error.issues;
      const firstIssue = parse.error.issues[0];
      reason = firstIssue
        ? `Schema validation failed at ${firstIssue.path.join('.') || '<root>'}: ${firstIssue.message}`
        : 'Schema validation failed';
    }
  } else {
    const rules = config.rules as string; // narrowed above
    const interpolated = interpolatePrompt(rules, ctx);
    const prompt =
      `You are a safety gate. Evaluate the following input against these rules:\n\n` +
      `Rules: ${interpolated}\n\n` +
      `Input:\n{{input}}\n\n` +
      `Reply with exactly PASS or FAIL on the first line, then a brief reason on the second line.`;

    const result = await runLlmCall(ctx, {
      stepId: step.id,
      prompt,
      modelOverride: config.modelOverride,
      temperature: config.temperature ?? 0.1,
      reasoningEffort: config.reasoningEffort ?? undefined,
    });

    tokensUsed = result.tokensUsed;
    costUsd = result.costUsd;

    const firstLine = result.content.trim().split('\n')[0].trim().toUpperCase();
    passed = firstLine.startsWith('PASS');
    reason = result.content.trim().split('\n').slice(1).join('\n').trim() || result.content.trim();
  }

  const verdict = passed ? 'pass' : 'fail';

  // Resolve next step based on the verdict edge condition.
  const nextEdge = step.nextSteps.find((e) => e.condition?.toLowerCase() === verdict);

  // If failAction is 'flag', we continue to the pass edge even on failure.
  const effectiveEdge =
    !passed && failAction === 'flag'
      ? (step.nextSteps.find((e) => e.condition?.toLowerCase() === 'pass') ?? nextEdge)
      : nextEdge;

  return {
    output: {
      passed,
      reason,
      verdict,
      failAction,
      // `issues` only present in schema mode on fail. Lets the retry
      // context interpolate `{{validate_x.output.issues}}` into the
      // producer's retry prompt to give it precise feedback.
      ...(issues !== undefined ? { issues } : {}),
    },
    tokensUsed,
    costUsd,
    nextStepIds: effectiveEdge ? [effectiveEdge.targetStepId] : undefined,
  };
}

registerStepType('guard', executeGuard);
