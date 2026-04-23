/**
 * Event Hook Types
 *
 * Defines the event types, payload shapes, and action configurations
 * used by the hook registry and dispatcher.
 */

/** All supported hook event types */
export const HOOK_EVENT_TYPES = [
  'conversation.started',
  'message.created',
  'workflow.started',
  'workflow.completed',
  'workflow.failed',
  'agent.updated',
] as const;

export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

/** Payload delivered with each hook event */
export interface HookEventPayload {
  eventType: HookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Webhook action — dispatches an HTTP POST to an external URL */
export interface WebhookAction {
  type: 'webhook';
  url: string;
  headers?: Record<string, string>;
}

export type HookAction = WebhookAction;

/** Filter criteria for selective hook firing */
export interface HookFilter {
  agentSlug?: string;
  agentId?: string;
  userId?: string;
  [key: string]: unknown;
}
