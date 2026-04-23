/**
 * Event Hook Types
 *
 * Defines the event types, payload shapes, and action configurations
 * used by the hook registry and dispatcher.
 */

import { z } from 'zod';
import { isSafeProviderUrl } from '@/lib/security/safe-url';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from './signing';

const RESERVED_HEADER_NAMES = new Set(
  [SIGNATURE_HEADER, TIMESTAMP_HEADER].map((h) => h.toLowerCase())
);

/**
 * True when `headers` contains a key that collides with a reserved
 * signing header. Admin write endpoints reject these so signing always
 * wins; the dispatch path additionally spreads signing headers last as
 * defense-in-depth for any pre-existing bad data.
 */
export function hasReservedHookHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => RESERVED_HEADER_NAMES.has(k.toLowerCase()));
}

export const RESERVED_HEADER_ERROR = `Custom headers cannot override ${SIGNATURE_HEADER} or ${TIMESTAMP_HEADER} (reserved for HMAC signing)`;

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

/**
 * Webhook action schema — dispatches an HTTP POST to an external URL.
 *
 * Used to validate Prisma JSON rows (`AiEventHook.action`) at dispatch
 * time, so dispatch code can never trust a cast from the database.
 */
export const WebhookActionSchema = z.object({
  type: z.literal('webhook'),
  url: z
    .string()
    .url()
    .refine((url) => isSafeProviderUrl(url), 'URL is not allowed (private or internal address)'),
  headers: z.record(z.string(), z.string()).optional(),
});

export type WebhookAction = z.infer<typeof WebhookActionSchema>;
export type HookAction = WebhookAction;

/**
 * Hook event payload schema.
 *
 * Used to validate Prisma JSON rows (`AiEventHookDelivery.payload`)
 * before re-dispatching queued retries.
 */
export const HookEventPayloadSchema = z.object({
  eventType: z.enum(HOOK_EVENT_TYPES),
  timestamp: z.string().datetime(),
  data: z.record(z.string(), z.unknown()),
});

export type HookEventPayload = z.infer<typeof HookEventPayloadSchema>;

/** Filter criteria for selective hook firing */
export interface HookFilter {
  agentSlug?: string;
  agentId?: string;
  userId?: string;
  [key: string]: unknown;
}
