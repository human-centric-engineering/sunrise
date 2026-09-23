/**
 * MCP runtime singletons.
 *
 * Extracted out of `index.ts` so leaf modules (protocol-handler, registry
 * helpers) can grab the rate limiter without dragging the full re-export
 * barrel into a cycle.
 *
 * Platform-agnostic: no Next.js imports.
 *
 * Tenancy posture (lib/tenancy/process-state.ts): `rateLimiter` is row-keyed on
 * MCP API key id, and the READ is keyed by the caller's own key
 * (`check(auth.apiKeyId, …)`), so no caller reaches another org's counter.
 *
 * It used to hold `sessionManager` too, and a module-scope throw that refused
 * `MCP_SESSION_MODE=stateful` on any platform announcing itself
 * function-per-request. Both went with the stateful transport (§39 t-718):
 * there is no process-held MCP state left to be wrong about on a
 * multi-instance deploy, so there is nothing for that guard to catch.
 */

import { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';

let rateLimiter: McpRateLimiter | null = null;

export function getMcpRateLimiter(): McpRateLimiter {
  if (!rateLimiter) {
    rateLimiter = new McpRateLimiter();
  }
  return rateLimiter;
}

/** Test/shutdown helper — clears the singletons. */
export function resetMcpSingletons(): void {
  rateLimiter = null;
}
