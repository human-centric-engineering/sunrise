/**
 * Event → entity-payload-key map.
 *
 * Single source of truth for which payload field carries the agent or
 * workflow identifier for a given event type. The dispatcher uses this
 * to apply dimension-specific entity scoping on `AiWebhookSubscription`
 * rows (see `agentIds` / `workflowIds` columns).
 *
 * Rules:
 *   - Absent map entry OR empty record  → event has no scopable entity,
 *     scoped subs match regardless of their filters.
 *   - `agent` key set                   → dispatcher reads payload[key]
 *     and intersects against the subscription's `agentIds` filter.
 *   - `workflow` key set                → same, for `workflowIds`.
 *   - Payload is missing the expected ID despite the event being mapped
 *     → fail-closed: a sub with a non-empty filter on that dimension
 *     does NOT match. Prevents an enrichment bug from leaking events
 *     to scoped subscribers.
 *
 * When adding a new wired event type, add a row here (or leave it out
 * if the event has no scopable entity). The `EVENT_ENTITY_KEYS_COVERS_ALL`
 * test asserts every entry in `WEBHOOK_EVENT_TYPES` has a deliberate
 * decision here.
 */

export interface EventEntityKeys {
  /** Payload field holding the agent id (if any). */
  agent?: string;
  /** Payload field holding the workflow id (if any). */
  workflow?: string;
}

export const EVENT_ENTITY_KEYS: Record<string, EventEntityKeys> = {
  // Agent-typed
  agent_updated: { agent: 'agentId' },
  budget_exceeded: { agent: 'agentId' },
  chat_budget_exceeded_per_turn: { agent: 'agentId' },
  conversation_escalated: { agent: 'agentId' },

  // Workflow-typed
  workflow_failed: { workflow: 'workflowId' },
  approval_required: { workflow: 'workflowId' },
  workflow_budget_exceeded: { workflow: 'workflowId' },
  execution_crashed: { workflow: 'workflowId' },

  // Unscopable — provider-level or system-wide; scoped subs always match
  circuit_breaker_opened: {},

  // Documented event types not currently fired with explicit entity IDs.
  // Listed so the coverage test passes; scoped subs always match until a
  // dispatch site adds the relevant ID to the payload and the row is
  // updated.
  conversation_started: {},
  conversation_completed: {},
  message_created: {},
  budget_threshold_reached: {},
  execution_completed: {},
  execution_failed: {},
};

/**
 * Apply dimension-specific entity scoping to a single subscription.
 *
 * Returns `true` when the subscription should receive the event,
 * `false` when an entity filter excludes it. See the rules block at
 * the top of this file for the precise semantics.
 */
export function matchesEntityScope(
  eventType: string,
  payload: Record<string, unknown>,
  sub: { agentIds?: string[] | null; workflowIds?: string[] | null }
): boolean {
  const keys = EVENT_ENTITY_KEYS[eventType] ?? {};
  const agentIds = sub.agentIds ?? [];
  const workflowIds = sub.workflowIds ?? [];

  if (agentIds.length > 0 && keys.agent) {
    const payloadAgentId = payload[keys.agent];
    if (typeof payloadAgentId !== 'string' || !agentIds.includes(payloadAgentId)) {
      return false;
    }
  }

  if (workflowIds.length > 0 && keys.workflow) {
    const payloadWorkflowId = payload[keys.workflow];
    if (typeof payloadWorkflowId !== 'string' || !workflowIds.includes(payloadWorkflowId)) {
      return false;
    }
  }

  return true;
}
