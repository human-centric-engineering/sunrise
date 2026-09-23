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
 * **All three are `'this-org'`** (§108 t-716): each announces that tenant-owned
 * CONTENTS changed — an agent, a workflow, a knowledge document — so only the
 * mutating org's subscribers should re-read. Every org's sessions subscribe to
 * the same `sunrise://…` URI, so before the audience was explicit, one org's
 * agent edit told every other org that its agent list had changed. Nothing
 * leaked: the re-read is org-scoped by §107, and the orgs whose lists had not
 * changed would have found them unchanged. What crossed was the signal — an
 * org learning, repeatedly and in real time, when someone else is working.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { broadcastMcpResourceUpdated } from '@/lib/orchestration/mcp';

/** Agent CRUD touches `sunrise://agents` (the list of active agents). */
export function notifyMcpAgentsChanged(): void {
  broadcastMcpResourceUpdated('sunrise://agents', 'this-org');
}

/** Workflow CRUD touches `sunrise://workflows`. */
export function notifyMcpWorkflowsChanged(): void {
  broadcastMcpResourceUpdated('sunrise://workflows', 'this-org');
}

/**
 * Knowledge mutations (new doc, re-embed, delete) invalidate every
 * subscriber of `sunrise://knowledge/search` since their search results may
 * now differ.
 */
export function notifyMcpKnowledgeChanged(): void {
  broadcastMcpResourceUpdated('sunrise://knowledge/search', 'this-org');
}
