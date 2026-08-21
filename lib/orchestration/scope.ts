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

// ─── Scope binding ────────────────────────────────────────────────────────
//
// Validating the carrier on read (above) is only half of what a persisted scope
// is for. The other half is making it **bind** a capability's arguments: a
// scoped caller should be able to omit the scoped parameter, and must not be
// able to act outside its scope by naming a different one.
//
// Before #586 the carrier reached `execute()` and stopped there, so every
// scoped capability consumed it by hand — or a fork patched the dispatch path.
//
// **The binding is declared, never inferred.** A capability says
// `register(cap, { scopedBy: 'projectId' })`; the dispatcher does not go
// looking. The first design read the binding out of the capability's published
// `functionDefinition.parameters` and armed itself whenever a scope map was
// present, and three review rounds found four separate ways that was wrong:
// the fold ran before a Zod transform could undo it; the "fails closed" gate
// could not tell a `Map` from a readable object; a pin the fold wrote could be
// stripped by `z.object()` and read as "nothing to hold"; and it armed on the
// consumer-chat scope, which arrives from an untrusted request body. Measured
// against the fork that asked for this: the inference covered 19 of its 29
// capabilities and silently covered none of its nine `featureId`-keyed writes.
//
// Declaring the binding removes the guess. `parameters` is not consulted at
// all, so the admin-editable JSON can no longer disagree with the Zod schema
// the author wrote.

/** A scope key the caller named with a value that is not the key's scope. */
export interface ScopeConflict {
  /** The bound parameter name, which is also the scope key. */
  key: string;
  /** What the caller's scope pins it to. */
  expected: string;
}

export type ScopeFoldResult =
  | {
      ok: true;
      /** The arguments to dispatch. A new object when anything was filled. */
      args: unknown;
      /** Bound keys supplied because the caller omitted them. */
      filled: string[];
      /** Bound keys the caller's scope does not pin — this call is unscoped on them. */
      unpinned: string[];
    }
  | { ok: false; conflicts: ScopeConflict[] };

/** Normalises the `scopedBy` option to a list. */
export function scopeKeysOf(scopedBy: string | readonly string[] | undefined): string[] {
  if (scopedBy === undefined) return [];
  return typeof scopedBy === 'string' ? [scopedBy] : [...scopedBy];
}

/** A non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An object whose properties can actually be **read** by inspection.
 *
 * `typeof x === 'object'` is true of a `Map`, a `URLSearchParams`, a `Date` and
 * every class instance, and `hasOwnProperty(map, 'projectId')` is `false` for
 * all of them — their data lives in internal slots or behind accessors on the
 * prototype. A check gated on `typeof` therefore looks, sees nothing, and
 * concludes the invariant holds while `execute()` reads the caller's value out
 * of `map.get('projectId')`. One `.transform(v => new Map(…))`, or a "parse,
 * don't validate" class of the kind the Zod docs encourage, was enough.
 *
 * So: the prototype must be `Object.prototype` or `null`, and every own
 * enumerable key must be a **data** property. An accessor is rejected even on
 * an otherwise-plain object, because a getter can return one value here and
 * another to `execute` — which also closes the double-read window between them.
 */
function isReadableArgsObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) return false;
  }
  return true;
}

/** Missing, null, or the empty string — the caller did not supply a value. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Fold a caller's scope into the arguments of a capability that declared a
 * binding for it.
 *
 * For each key in `scopedBy` that the caller's scope pins:
 *
 * - **fill-if-absent** — the caller omitted it, so supply the scope value;
 * - **cross-scope guard** — the caller named something else, so refuse.
 *
 * A bound key the caller's scope does **not** pin is reported in `unpinned` and
 * left alone: an unscoped key is a deliberate configuration (Sunrise ships
 * `McpApiKey.scope = NULL` meaning system-wide), so this is not the place to
 * refuse it. The dispatcher logs it.
 *
 * Never mutates `rawArgs`, and returns it unchanged when nothing applies.
 *
 * **This is half of the boundary.** It runs before `handler.validate()` and
 * cannot see what a Zod transform does afterwards — {@link assertScopeHeld} is
 * the other half, and is the one that actually holds the line.
 *
 * **Args that are not a plain object pass through here.** A scoped call with
 * `args: "hello"` cannot be folded; inventing an object would turn a request
 * the capability's schema might reject into one it accepts. It is not waved
 * through — `assertScopeHeld` refuses it after validation, because "the schema
 * will probably reject it" is a guess and this is a boundary.
 *
 * **Comparison is strict and never coerces.** A `projectId` of `5` is not the
 * scope's `"5"`, and `{ toString: () => 'p1' }` is not `'p1'`; coercing would
 * let any caller satisfy a tenant check.
 */
export function foldScopeIntoArgs(
  rawArgs: unknown,
  scope: Record<string, string>,
  scopedBy: readonly string[]
): ScopeFoldResult {
  const pinned = scopedBy.filter((key) => Object.prototype.hasOwnProperty.call(scope, key));
  const unpinned = scopedBy.filter((key) => !pinned.includes(key));
  if (pinned.length === 0) return { ok: true, args: rawArgs, filled: [], unpinned };

  if (!isPlainObject(rawArgs)) return { ok: true, args: rawArgs, filled: [], unpinned };

  const conflicts: ScopeConflict[] = [];
  const filled: string[] = [];

  for (const key of pinned) {
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
  if (filled.length === 0) return { ok: true, args: rawArgs, filled: [], unpinned };

  const args: Record<string, unknown> = { ...rawArgs };
  for (const key of filled) {
    // `defineProperty`, not `args[key] = …`. Assigning to `__proto__` sets the
    // prototype instead of creating a property, so a capability bound on a
    // `__proto__` key would dispatch with the scope silently absent.
    Object.defineProperty(args, key, {
      value: scope[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, args, filled, unpinned };
}

/** Why a validated call could not be allowed through. */
export type ScopeAssertion =
  | { held: true }
  /** A bound key carries a value that is not the caller's scope value. */
  | { held: false; reason: 'conflict'; keys: string[] }
  /** A bound key vanished, or the args cannot be read — the pin is unverifiable. */
  | { held: false; reason: 'unenforceable' };

/**
 * Re-assert the binding on the args `execute()` will actually receive.
 *
 * **{@link foldScopeIntoArgs} alone is not a boundary**, and the first version
 * of this feature shipped believing it was. The fold runs before
 * `handler.validate()`, and validation is a Zod *pipeline*, not a filter — it
 * may transform. Three shipped built-ins wrap their schema in
 * `z.preprocess(unwrapApprovalPayload, …)`, which merges an `approvalPayload`
 * object **over** the top level by design. So:
 *
 * ```
 * scope   { projectId: 'A' }
 * args    { approvalPayload: { projectId: 'B' } }     ← no top-level key
 * fold  → { approvalPayload: {…}, projectId: 'A' }    ← fill-if-absent, no conflict
 * validate preprocess
 *       → { approvalPayload: {…}, projectId: 'B' }    ← execute() would see B
 * ```
 *
 * The rule that was missing: **the fold protects the args entering `validate`;
 * the only args that matter are the ones entering `execute`.**
 *
 * Because the capability **declared** the binding, this can demand more than
 * "no conflict": every pinned key must be **present and equal**. An absent key
 * is `unenforceable`, not held — `z.object()` strips unknown keys, so a
 * capability that names a binding its schema does not accept would otherwise
 * dispatch with the discriminator gone, under a boundary reporting success.
 * The inferred design could not make that demand, because it never knew whether
 * the capability really had the parameter.
 *
 * **Fails closed when it cannot look** — see {@link isReadableArgsObject}.
 *
 * **What it cannot cover.** Only top-level own properties are inspected. A
 * capability that resolves its scope from a child id (`{ featureId }` → the
 * feature's project) is not enforced here and must not declare `scopedBy` for
 * it; that check belongs in `execute()`, or in a {@link CapabilityGuard}.
 */
export function assertScopeHeld(
  validated: unknown,
  scope: Record<string, string>,
  scopedBy: readonly string[]
): ScopeAssertion {
  const pinned = scopedBy.filter((key) => Object.prototype.hasOwnProperty.call(scope, key));
  if (pinned.length === 0) return { held: true };

  if (!isReadableArgsObject(validated)) return { held: false, reason: 'unenforceable' };

  const conflicts: string[] = [];
  const missing: string[] = [];
  for (const key of pinned) {
    if (!Object.prototype.hasOwnProperty.call(validated, key)) {
      missing.push(key);
    } else if (validated[key] !== scope[key]) {
      conflicts.push(key);
    }
  }

  if (conflicts.length > 0) return { held: false, reason: 'conflict', keys: conflicts };
  if (missing.length > 0) return { held: false, reason: 'unenforceable' };
  return { held: true };
}
