/**
 * Resource update hooks
 *
 * Centralised, named callers for `broadcastMcpResourceUpdated`. Mutation
 * sites import the named helper rather than hard-coding the URI string —
 * if we ever rename `sunrise://agents` etc. there's one place to change.
 *
 * Every helper is fire-and-forget: it returns nothing, never throws (the
 * underlying broadcast swallows errors), and no-ops when there are no
 * subscribers. Mutation routes can call these at the end of a successful
 * write with zero error-handling boilerplate.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { broadcastMcpResourceUpdated } from '@/lib/orchestration/mcp';

/** Agent CRUD touches `sunrise://agents` (the list of active agents). */
export function notifyMcpAgentsChanged(): void {
  broadcastMcpResourceUpdated('sunrise://agents');
}

/** Workflow CRUD touches `sunrise://workflows`. */
export function notifyMcpWorkflowsChanged(): void {
  broadcastMcpResourceUpdated('sunrise://workflows');
}

/**
 * Knowledge mutations (new doc, re-embed, delete) invalidate every
 * subscriber of `sunrise://knowledge/search` since their search results may
 * now differ.
 */
export function notifyMcpKnowledgeChanged(): void {
  broadcastMcpResourceUpdated('sunrise://knowledge/search');
}
