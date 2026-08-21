/**
 * Which callers may drive a capability's declared scope binding.
 *
 * `CapabilityContext.scopeIsAuthoritative` is the difference between a scope
 * the platform wrote and one an end user posted. Getting it wrong in the
 * permissive direction is a real defect, not a style slip: an earlier design of
 * this feature armed on the presence of a scope map alone, which meant
 * `POST /api/v1/chat/stream` — whose `scope` comes straight from an untrusted
 * request body, and whose own schema calls it "a routing/context hint, never
 * proof of authorization" — silently wrote core tools' arguments (#586).
 *
 * That is invisible in a diff and has no natural test, so the roster is
 * **derived** and checked here rather than remembered.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Files that thread a caller's `scope` onto a dispatch context. Derived, not
 * listed — a new one that forgets to make a decision fails this test.
 */
const SCOPE_THREADING = /scope: (?:caller|params|context|request|auth)\.scope/;

const CANDIDATES = [
  'lib/orchestration/mcp/tool-registry.ts',
  'lib/orchestration/engine/context.ts',
  'lib/orchestration/capabilities/built-in/run-workflow.ts',
  'lib/orchestration/chat/streaming-handler.ts',
  'lib/orchestration/mcp/protocol-handler.ts',
] as const;

/** Carriers the platform writes, and may therefore act as authorization. */
const AUTHORITATIVE = new Set<string>([
  // `McpApiKey.scope` — admin-written, re-validated at auth.
  'lib/orchestration/mcp/tool-registry.ts',
  // `AiWorkflow{Execution,Schedule,Trigger}.scope` — admin-written, re-validated on read.
  'lib/orchestration/engine/context.ts',
  // Inherits the parent execution's authority along with its scope.
  'lib/orchestration/capabilities/built-in/run-workflow.ts',
]);

/** Carriers that are a hint only, and must never arm the binding. */
const UNTRUSTED = new Map<string, string>([
  [
    'lib/orchestration/chat/streaming-handler.ts',
    'ChatRequest.scope arrives from an untrusted consumer request body',
  ],
  [
    'lib/orchestration/mcp/protocol-handler.ts',
    'hands the key scope to callMcpTool, which decides authority itself',
  ],
]);

describe('scope authority roster', () => {
  it('finds the call sites it is written to check', () => {
    // A scanner that matches nothing is green and looks healthy. Floor first.
    const threading = CANDIDATES.filter((file) => SCOPE_THREADING.test(readFileSync(file, 'utf8')));
    expect(threading.length).toBeGreaterThanOrEqual(4);
  });

  it.each([...AUTHORITATIVE])('%s marks its scope authoritative', (file) => {
    expect(readFileSync(file, 'utf8')).toContain('scopeIsAuthoritative');
  });

  it.each([...UNTRUSTED])('%s never marks its scope authoritative — %s', (file) => {
    // The one that matters. If this ever passes a scope as authoritative, an
    // end user picks the tenant a capability acts on.
    expect(readFileSync(file, 'utf8')).not.toContain('scopeIsAuthoritative');
  });

  it('accounts for every file that threads a scope onto a dispatch context', () => {
    // Neither list may quietly gain a member: a new caller must be classified.
    const threading = CANDIDATES.filter((file) => SCOPE_THREADING.test(readFileSync(file, 'utf8')));
    const classified = new Set([...AUTHORITATIVE, ...UNTRUSTED.keys()]);
    expect(threading.filter((file) => !classified.has(file))).toEqual([]);
  });
});
