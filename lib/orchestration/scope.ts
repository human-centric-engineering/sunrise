/**
 * Persisted scope carrier helpers
 *
 * `CapabilityContext.scope` (introduced in 0.5.0) can be persisted on several
 * rows — `AiWorkflowExecution.scope`, `AiWorkflowSchedule.scope`,
 * `AiWorkflowTrigger.scope`, `McpApiKey.scope`. Those JSON columns are
 * admin-written and MUST NOT be trusted raw when read back: a malformed value
 * (hand-edited row, older shape) must never wedge a run or lock a caller out.
 *
 * This helper centralises the validate-on-read contract for the workflow-side
 * columns: parse against `workflowScopeSchema`, and on failure drop to
 * unscoped (return `undefined`) with a warning rather than throwing. Callers
 * spread the result conditionally: `...(scope ? { scope } : {})`. The same
 * guard is applied to any other untrusted scope value that is about to be
 * persisted onto one of those columns — notably an inbound adapter's
 * `normalise()`-returned scope, which is derived from the request payload and
 * is likewise not trusted raw (tag it `{ source: 'adapter' }` in `context`).
 */

import { logger as defaultLogger, type Logger } from '@/lib/logging';
import { workflowScopeSchema } from '@/lib/validations/orchestration';

/**
 * Validate a persisted scope JSON column before trusting it.
 *
 * Covers the **workflow-side** columns (`AiWorkflowExecution.scope`,
 * `AiWorkflowSchedule.scope`, `AiWorkflowTrigger.scope`), which all validate
 * against `workflowScopeSchema`. The MCP-key column (`McpApiKey.scope`) shares
 * the same contract but validates inline in `lib/orchestration/mcp/auth.ts`
 * against its own `mcpKeyScopeSchema` alias, kept local to the MCP auth module.
 *
 * @param value   The raw scope value (`null`/`undefined` when unset).
 * @param context Structured fields identifying the source, logged if the value
 *   is malformed (e.g. `{ scheduleId }`, `{ triggerId }`, `{ executionId }`, or
 *   `{ triggerId, source: 'adapter' }` for an adapter-derived value).
 * @param log     Logger for the malformed-drop warning. Pass a context-bound
 *   logger (e.g. the engine's `baseLogger`, which carries `workflowId`/`userId`)
 *   to preserve correlation; defaults to the module logger.
 * @returns The validated `Record<string, string>`, or `undefined` when the
 *   column is unset or malformed (drop-to-unscoped — never throws).
 */
export function resolvePersistedScope(
  value: unknown,
  context: Record<string, unknown>,
  log: Logger = defaultLogger
): Record<string, string> | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = workflowScopeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log.warn('Dropped malformed persisted workflow scope', {
    ...context,
    issues: parsed.error.issues.length,
  });
  return undefined;
}

// ─── Scope fold ───────────────────────────────────────────────────────────
//
// Validating the carrier on read (above) is only half of what a persisted
// scope is for. The other half is making it **ambient in a tool's arguments**:
// a scoped caller should be able to omit the scoped parameter, and must not be
// able to act outside its scope by naming a different value.
//
// Before #586 the carrier reached `execute()` and stopped there, so every
// scoped capability consumed it by hand — or a fork patched the dispatch path.
// Both halves now live here, and the dispatcher applies the fold to every
// carrier: MCP `tools/call`, a workflow execution, and a nested `run-workflow`.

/** A scope key the caller named with a value that is not the key's scope. */
export interface ScopeConflict {
  /** The parameter name, which is also the scope key. */
  key: string;
  /** What the caller's scope pins it to. */
  expected: string;
}

export type ScopeFoldResult =
  | {
      ok: true;
      /** The arguments to dispatch. A new object when anything was filled. */
      args: unknown;
      /** Scope keys supplied because the caller omitted them. */
      filled: string[];
    }
  | { ok: false; conflicts: ScopeConflict[] };

/** A non-null, non-array object — the only shape a fold can apply to. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Does this tool's JSON Schema declare a property of that name?
 *
 * **`hasOwnProperty`, not `properties[key] !== undefined`.** Every object
 * literal inherits `toString`, `constructor`, `valueOf` and friends, so a
 * scope key named after one would read as "declared" by any tool in the
 * system and be folded into args that never asked for it.
 */
function declaresProperty(parameters: unknown, key: string): boolean {
  if (!isPlainObject(parameters)) return false;
  const properties = parameters.properties;
  if (!isPlainObject(properties)) return false;
  return Object.prototype.hasOwnProperty.call(properties, key);
}

/** Missing, null, or the empty string — the caller did not supply a value. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Fold a caller's scope into a capability's arguments.
 *
 * For each key in `scope`, **and only if the capability's own parameter schema
 * declares a property of that name**:
 *
 * - **fill-if-absent** — the caller omitted it, so supply the scope value;
 * - **cross-scope guard** — the caller named something else, so refuse.
 *
 * The "declares the property" gate is what keeps this domain-agnostic: a tool
 * keyed on some other id is untouched, and nothing is injected into a schema
 * that would reject the extra key. Core names no scope keys; a fork maps the
 * carrier to its own domain (`{ projectId }`, `{ tenantId }`, …).
 *
 * Never mutates `rawArgs`. Returns it unchanged when nothing applies, so the
 * common case allocates nothing.
 *
 * **Args that are not a plain object pass straight through.** A scoped call
 * with `args: "hello"` cannot be folded, and inventing an object here would
 * turn a request the capability's own schema is about to reject into one it
 * accepts. It stays rejected, one step later, by `handler.validate`.
 *
 * **Comparison is strict and never coerces.** A `projectId` of `5` is not the
 * scope's `"5"`; coercing would let `{ toString: () => 'x' }` satisfy a tenant
 * check. Scope values are strings by `capabilityScopeSchema`, so anything else
 * the caller supplies is a conflict by definition.
 *
 * @param rawArgs    Arguments as the caller supplied them.
 * @param scope      The validated carrier from `CapabilityContext.scope`.
 * @param parameters The capability's `functionDefinition.parameters` (JSON Schema).
 */
export function foldScopeIntoArgs(
  rawArgs: unknown,
  scope: Record<string, string>,
  parameters: unknown
): ScopeFoldResult {
  const applicable = Object.keys(scope).filter((key) => declaresProperty(parameters, key));
  if (applicable.length === 0) return { ok: true, args: rawArgs, filled: [] };

  if (!isPlainObject(rawArgs)) return { ok: true, args: rawArgs, filled: [] };

  const conflicts: ScopeConflict[] = [];
  const filled: string[] = [];

  for (const key of applicable) {
    const supplied = Object.prototype.hasOwnProperty.call(rawArgs, key) ? rawArgs[key] : undefined;
    if (isAbsent(supplied)) {
      filled.push(key);
      continue;
    }
    if (supplied !== scope[key]) conflicts.push({ key, expected: scope[key] });
  }

  // Conflicts win. Filling some keys while refusing others would dispatch a
  // partially-scoped call, which is the shape this exists to prevent.
  if (conflicts.length > 0) return { ok: false, conflicts };
  if (filled.length === 0) return { ok: true, args: rawArgs, filled: [] };

  const args: Record<string, unknown> = { ...rawArgs };
  for (const key of filled) {
    // `defineProperty`, not `args[key] = …`. Assigning to `__proto__` sets the
    // prototype instead of creating a property, so a tool that declared a
    // `__proto__` parameter would be dispatched with the scope silently absent.
    Object.defineProperty(args, key, {
      value: scope[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, args, filled };
}
