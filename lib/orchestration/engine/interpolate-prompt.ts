/**
 * Pure prompt-template interpolation.
 *
 * Lifted out of `llm-runner.ts` so the admin trace viewer can re-run
 * the same logic client-side against trace data — letting an admin see
 * what the LLM actually received, with `{{stepId.output}}`,
 * `{{input.foo}}` etc. substituted in.
 *
 * No imports beyond the narrow `InterpolationContext` type defined
 * here. Safe to import from any boundary (server, client, edge).
 *
 *   - `{{input}}`                 → JSON of ctx.inputData or the string
 *                                   form when inputData is a primitive.
 *   - `{{input.key}}`             → ctx.inputData.key (JSON-stringified
 *                                   if not a string).
 *   - `{{previous.output}}`       → ctx.stepOutputs[previousStepId]
 *                                   (JSON-stringified if not a string).
 *   - `{{<stepId>.output}}`       → ctx.stepOutputs[stepId]
 *                                   (JSON-stringified if not a string).
 *   - `{{vars.<path>}}`           → drills into ctx.variables along the
 *                                   dotted path; e.g.
 *                                   `vars.__retryContext.failureReason`.
 *   - `{{#if vars.<path>}}body{{/if}}`
 *                                 → body is included only when the
 *                                   resolved value is truthy. Flat
 *                                   conditionals only — bodies must not
 *                                   contain another `{{#if ...}}`.
 *
 * Missing references expand to the empty string — mirrors the common
 * template-engine behaviour and keeps executors from needing to
 * understand template failures.
 */

/**
 * Narrowed shape needed for interpolation. The engine's full
 * `ExecutionContext` satisfies this; the trace viewer constructs a
 * client-side equivalent from the execution detail + trace entries.
 */
export interface InterpolationContext {
  /** Workflow input — `{{input}}` and `{{input.foo}}` resolve here. */
  inputData: Record<string, unknown>;
  /** Output of each completed step, keyed by step id. */
  stepOutputs: Record<string, unknown>;
  /** Runtime variables — `{{vars.foo.bar}}` walks this object. */
  variables: Record<string, unknown>;
}

export interface InterpolateOptions {
  /**
   * How object/array values are stringified when an interpolation
   * expands to a non-string.
   *   - `'plain'` (default): `JSON.stringify(value)` — compact single
   *     line, suitable for LLM prompts where token efficiency matters.
   *   - `'markdown'`: pretty-printed JSON wrapped in a fenced
   *     ```json``` block. Suitable for prompts that get rendered as
   *     markdown to humans (e.g. the human_approval step's prompt
   *     shown to admins in the approval queue).
   */
  format?: 'plain' | 'markdown';
}

export function interpolatePrompt(
  template: string,
  ctx: Readonly<InterpolationContext>,
  previousStepId?: string,
  options?: InterpolateOptions
): string {
  const stringify = options?.format === 'markdown' ? stringifyMarkdownValue : stringifyValue;

  // First pass: resolve flat `{{#if EXPR}}BODY{{/if}}` conditionals.
  // Body match is non-greedy so multiple flat conditionals on the same
  // line each terminate at their own `{{/if}}`.
  const withoutConditionals = template.replace(
    /\{\{#if\s+([^}]+?)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, rawExpr: string, body: string) => {
      const expr = rawExpr.trim();
      const value = expr.startsWith('vars.')
        ? resolveDottedPath(ctx.variables, expr.slice('vars.'.length))
        : undefined;
      return isTruthy(value) ? body : '';
    }
  );

  // Second pass: resolve single-token `{{...}}` references.
  return withoutConditionals.replace(/\{\{([^}]+)\}\}/g, (_match, rawExpr: string) => {
    const expr = rawExpr.trim();

    if (expr === 'input') {
      // `input` is special: when ctx.inputData is a primitive string we
      // emit it raw (no JSON quoting); otherwise stringify through the
      // configured stringifier so markdown callers get a fenced block.
      return typeof ctx.inputData === 'string' ? ctx.inputData : stringify(ctx.inputData);
    }

    if (expr.startsWith('input.')) {
      const key = expr.slice('input.'.length);
      const value = ctx.inputData[key];
      return stringify(value);
    }

    if (expr === 'previous.output') {
      if (!previousStepId) return '';
      return stringify(ctx.stepOutputs[previousStepId]);
    }

    if (expr.startsWith('vars.')) {
      return stringify(resolveDottedPath(ctx.variables, expr.slice('vars.'.length)));
    }

    const dotIdx = expr.lastIndexOf('.');
    if (dotIdx > 0 && expr.slice(dotIdx + 1) === 'output') {
      const stepId = expr.slice(0, dotIdx);
      return stringify(ctx.stepOutputs[stepId]);
    }

    return '';
  });
}

function resolveDottedPath(root: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

/**
 * Markdown-aware variant. Pretty-prints object/array values and wraps
 * them in a fenced ```json``` block so they render as a readable code
 * block when the interpolated prompt is shown through a markdown
 * renderer. Strings that happen to parse as JSON are unwrapped first
 * — this is a common pattern for upstream LLM steps that emit
 * stringified JSON (e.g. the `reflect` step's `finalDraft` field). All
 * other primitive values stringify as-is.
 */
function stringifyMarkdownValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (typeof value === 'string') {
    // Detect a string that's actually JSON-encoded structured data
    // (object or array) and unwrap so we render the structure rather
    // than the escaped one-line form. Plain strings pass through.
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') {
          return fencedJson(parsed);
        }
      } catch {
        // not JSON — fall through to the raw string path
      }
    }
    return value;
  }

  return fencedJson(value);
}

function fencedJson(value: unknown): string {
  try {
    const body = JSON.stringify(value, null, 2);
    if (body === undefined) return '';
    return `\n\n\`\`\`json\n${body}\n\`\`\`\n\n`;
  } catch {
    return '[unserializable]';
  }
}
