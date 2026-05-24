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
