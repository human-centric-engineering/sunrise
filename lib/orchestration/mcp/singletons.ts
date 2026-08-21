/**
 * MCP runtime singletons.
 *
 * Extracted out of `index.ts` so leaf modules (protocol-handler, registry
 * helpers) can grab the session manager / rate limiter without dragging
 * the full re-export barrel into a cycle.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { McpSessionManager } from '@/lib/orchestration/mcp/session-manager';
import { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';
import { env } from '@/lib/env';

/**
 * Platforms that announce themselves as function-per-request.
 *
 * `||` rather than `??` on purpose: `VERCEL=""` is falsy but not nullish, so
 * `??` would stop at the empty string and never reach the Lambda check.
 */
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * Refuse `stateful` where more than one process is known to serve traffic.
 *
 * At module scope, so it throws on the first import of the MCP singletons
 * rather than on the first request — the same shape as the `TENANCY_MODE` guard
 * in `lib/db/client.ts`. The failure it prevents is the worst kind to debug:
 * `initialize` succeeds on instance A, the next call lands on B, B looks the id
 * up in its own empty map and returns 404, and the client reports a connection
 * failure that "works on retry" purely by routing luck.
 *
 * **A safety net, not a boundary.** It only catches platforms that set a
 * well-known variable. A container deploy with `replicas: 2`, or a clustered
 * Node process, hits the identical bug and this will not fire — which is the
 * other half of why `stateless` is the default rather than a documented opt-in.
 */
if (env.MCP_SESSION_MODE === 'stateful' && SERVERLESS) {
  throw new Error(
    'MCP_SESSION_MODE=stateful holds sessions in per-process memory and cannot work where ' +
      'more than one process serves traffic: consecutive requests land on different ' +
      'instances, so the session created by `initialize` is not found and the client cannot ' +
      'connect. Use MCP_SESSION_MODE=stateless (the default), which needs no shared state — ' +
      'at the cost of the SSE stream, resources/subscribe and logging/setLevel. See ' +
      '.context/orchestration/mcp.md.'
  );
}

let sessionManager: McpSessionManager | null = null;
let rateLimiter: McpRateLimiter | null = null;

export function getMcpSessionManager(): McpSessionManager {
  if (!sessionManager) {
    sessionManager = new McpSessionManager();
  }
  return sessionManager;
}

export function getMcpRateLimiter(): McpRateLimiter {
  if (!rateLimiter) {
    rateLimiter = new McpRateLimiter();
  }
  return rateLimiter;
}

/** Test/shutdown helper — destroys the underlying managers and clears the singletons. */
export function resetMcpSingletons(): void {
  if (sessionManager) {
    sessionManager.destroy();
    sessionManager = null;
  }
  rateLimiter = null;
}
