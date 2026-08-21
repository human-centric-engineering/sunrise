/**
 * Which callers may bind a capability's arguments with their scope.
 *
 * `CapabilityContext.scopeIsAuthoritative` is the difference between a scope
 * the platform wrote and one an end user posted, and both directions are
 * defects: permissive lets `POST /api/v1/chat/stream` — whose `scope` comes
 * from an untrusted request body — decide what a tool acts on; restrictive
 * silently disables the boundary.
 *
 * **The previous version of this file was green while the boundary was wired to
 * exactly one of its three carriers.** It hardcoded a five-file `CANDIDATES`
 * list that omitted the two executors where the `CapabilityContext` is really
 * built, its regex alternation lacked the `ctx` those files use, and it graded
 * `engine/context.ts` — which builds an `ExecutionContext`, not a dispatch
 * context — as covered. It asserted that a string appeared in a file, which is
 * not the same claim as "this boundary is enforced".
 *
 * So: the roster is derived by walking `lib/`, and the real check is
 * behavioural — see `dispatcher.test.ts`, which dispatches through the
 * executor rather than hand-writing the flag.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';
import { describe, it, expect } from 'vitest';

/** Builds a dispatch context: threads a scope AND reaches the dispatcher. */
const THREADS_SCOPE = /(?:platformScope|hintScope)\(|scope:\s*\w+\.scope/;
const DISPATCHES = /capabilityDispatcher\.dispatch|dispatchWithBudget|callMcpTool\(/;

function sourceFiles(): string[] {
  return readdirSync('lib', { recursive: true, encoding: 'utf8' })
    .map((entry) => `lib/${entry.split(sep).join('/')}`)
    .filter((file) => file.endsWith('.ts'));
}

/** Files that build a `CapabilityContext` for a real dispatch. */
function dispatchContextSites(): string[] {
  return sourceFiles()
    .filter((file) => file !== 'lib/orchestration/scope.ts')
    .filter((file) => {
      const src = readFileSync(file, 'utf8');
      return THREADS_SCOPE.test(src) && DISPATCHES.test(src);
    })
    .sort();
}

/** Carriers the platform wrote, which may bind arguments. */
const AUTHORITATIVE = [
  'lib/orchestration/engine/executors/agent-call.ts',
  'lib/orchestration/engine/executors/tool-call.ts',
  'lib/orchestration/mcp/tool-registry.ts',
] as const;

/** Carriers that are a hint only. */
const HINT_ONLY = [
  ['lib/orchestration/chat/streaming-handler.ts', 'untrusted request body'],
] as const;

/**
 * Sites that hand a scope onward to something that makes the decision, rather
 * than building a dispatch context themselves. Found by the derivation — which
 * is the point of deriving: this one was not on my list.
 */
const DELEGATES = [
  ['lib/orchestration/mcp/protocol-handler.ts', 'hands the key scope to callMcpTool'],
] as const;

describe('scope authority roster', () => {
  it('finds the call sites it is written to check', () => {
    // A scanner that matches nothing is green and looks healthy. Floor first,
    // and pinned to the derived count so a shrinking roster fails too.
    expect(dispatchContextSites().length).toBe(
      AUTHORITATIVE.length + HINT_ONLY.length + DELEGATES.length
    );
  });

  it('classifies every site that builds a dispatch context', () => {
    // The assertion the previous version could not make: a new caller that
    // forgets to decide shows up here rather than defaulting quietly.
    const classified = new Set<string>([
      ...AUTHORITATIVE,
      ...HINT_ONLY.map(([file]) => file),
      ...DELEGATES.map(([file]) => file),
    ]);
    expect(dispatchContextSites().filter((file) => !classified.has(file))).toEqual([]);
  });

  it.each(AUTHORITATIVE)('%s builds its context with platformScope', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('platformScope(');
  });

  it.each(HINT_ONLY)('%s never marks its scope authoritative — %s', (file) => {
    // The one that matters. If this passes a scope as authoritative, an end
    // user picks the tenant a capability acts on.
    const src = readFileSync(file, 'utf8');
    expect(src).not.toContain('platformScope(');
    expect(src).not.toContain('scopeIsAuthoritative: true');
  });

  it.each(DELEGATES)('%s decides no authority of its own — %s', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toContain('platformScope(');
    expect(src).not.toContain('scopeIsAuthoritative');
  });

  it('keeps the authority decision out of run_workflow’s reach', () => {
    // `ExecuteOptions` has no authority field, so a scope passed to
    // `engine.execute()` is persisted and later read back as authoritative.
    // `run_workflow` must therefore drop a hint scope rather than forward it.
    const src = readFileSync('lib/orchestration/capabilities/built-in/run-workflow.ts', 'utf8');
    expect(src).toContain('context.scope && context.scopeIsAuthoritative');
  });
});
