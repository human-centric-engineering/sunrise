/**
 * Event Hook Types
 *
 * Defines the event types, payload shapes, and action configurations
 * used by the hook registry and dispatcher.
 */

import { z } from 'zod';
import { isSafeProviderUrl } from '@/lib/security/safe-url';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from '@/lib/orchestration/hooks/signing';

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
  'workflow.execution.failed',
  'workflow.paused_for_approval',
  'agent.updated',
  // Admin force-fail. Fired in addition to (not in place of)
  // `workflow.failed` so existing Slack / PagerDuty integrations keep
  // working unchanged, and consumers that want to distinguish admin
  // termination from a natural engine failure can subscribe to this
  // event specifically. Payload carries `{ executionId, workflowId,
  // actorUserId, reason }`.
  'execution.force_failed',
  // Capability quarantine lifecycle (item #42). `capability.quarantined`
  // fires when an admin puts a capability into soft or hard quarantine;
  // `capability.unquarantined` fires when the quarantine is lifted.
  // Auto-expiry (read-time) does NOT fire an unquarantined event — the
  // stored state is unchanged and the dispatcher just renders it as
  // active. Payloads carry `{ capabilityId, capabilitySlug,
  // capabilityName, mode, reason, expiresAt, actorUserId, at }`
  // (`mode` and `expiresAt` are omitted on unquarantined).
  'capability.quarantined',
  'capability.unquarantined',
  // The model asked for a tool the agent was never offered this turn (#488).
  // Always one of two things: a hallucinated name, or an injected tool call —
  // so it is a security signal, not an operational one, and it fires whether or
  // not the capability exists elsewhere in the registry. The handler refuses
  // the call; this event is how a fork notices it happened. Payload carries
  // `{ agentId, agentSlug, userId, toolName, advertised }` plus the surface's
  // own correlation ids — `conversationId` from chat, `executionId` + `stepId`
  // from a workflow `agent_call` step (#559). `advertised` is the tool set the
  // model actually had, so a reviewer can see what it invented the name from.
  //
  // Both surfaces emit it, and a subscriber keying only on `conversationId`
  // silently misses the workflow half. Treat neither as the riskier one: both
  // take a tool name from a model, and both read content an attacker may have
  // planted (chat additionally takes end-user text directly).
  'capability.refused_not_advertised',
] as const;

/** The event types Sunrise itself emits. */
export type CoreHookEventType = (typeof HOOK_EVENT_TYPES)[number];

/**
 * Event types owned by a fork rather than by Sunrise.
 *
 * `HOOK_EVENT_TYPES` is a closed list, so before this a fork could neither emit
 * its own domain event through the hook registry nor subscribe a webhook to one —
 * it had to add entries to a platform array, which conflicts on every upstream
 * sync and risks colliding with a name a future Sunrise release takes.
 *
 * The two prefixes mirror the reserved tiers documented in CUSTOMIZATION.md:
 * `app.` for a leaf fork, `framework.` for a fork that sits between Sunrise and
 * its own forks. Sunrise never emits either prefix, so the namespaces cannot
 * collide in future.
 *
 * A namespaced string union rather than a registration seam, deliberately: the
 * Zod schemas below are built at **module load**, before any `initApp()` runs,
 * and #462 showed boot order across module realms is not guaranteed under
 * Turbopack. A registration seam would validate against an empty registry
 * whenever the schema module loaded first.
 *
 * @example 'app.invoice.paid' · 'framework.tenant.provisioned'
 */
export type ForkHookEventType = `app.${string}` | `framework.${string}`;

/**
 * Any hook event type — core or fork-owned.
 *
 * **Widening note for forks:** this used to be exactly the core union, so an
 * exhaustive `switch` with an `assertNever` default will now fail to compile.
 * That is the intended failure: it is a compile-time prompt to decide what your
 * code does with an event it does not know, rather than a silent runtime
 * fall-through.
 */
export type HookEventType = CoreHookEventType | ForkHookEventType;

/** Matches a fork-owned event type. Anchored — `x.app.y` is not fork-owned. */
export const FORK_EVENT_TYPE_PATTERN = /^(app|framework)\.[a-zA-Z0-9._-]+$/;

/**
 * Validator for any hook event type.
 *
 * The core enum is kept as one arm of the union rather than replaced with
 * `z.string()`: this schema also validates `AiEventHookDelivery.payload` read
 * back from the database, and loosening it to any string would stop that being a
 * real check.
 */
export const hookEventTypeSchema = z.union([
  z.enum(HOOK_EVENT_TYPES),
  z
    .string()
    .regex(FORK_EVENT_TYPE_PATTERN, 'Fork event types must be namespaced `app.*` or `framework.*`'),
]);

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
  // Accepts fork-namespaced types too, so a queued retry for an app event
  // survives revalidation instead of being discarded as malformed (#465).
  eventType: hookEventTypeSchema,
  timestamp: z.string().datetime(),
  data: z.record(z.string(), z.unknown()),
});

export type HookEventPayload = z.infer<typeof HookEventPayloadSchema>;

/** Filter criteria for selective hook firing */
export const HookFilterSchema = z
  .object({
    agentSlug: z.string().optional(),
    agentId: z.string().optional(),
    userId: z.string().optional(),
  })
  .passthrough();

export type HookFilter = z.infer<typeof HookFilterSchema>;
