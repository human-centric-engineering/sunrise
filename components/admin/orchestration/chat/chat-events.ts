/**
 * Shared SSE event validator for admin chat surfaces.
 *
 * Wraps the generic frame parser in `lib/api/sse-parser.ts` with Zod
 * schemas matching the {@link ChatEvent} discriminated union from the
 * streaming chat handler. Returns a strictly-typed event or `null`
 * when validation fails — callers never have to cast `unknown` shapes
 * by hand, which keeps the no-`as`-on-external-data rule satisfied.
 *
 * Used by both the reusable `ChatInterface` and the bespoke
 * `EvaluationRunner` SSE loop. New event types should be added here
 * first; consumers then pick the variant(s) they care about.
 */

import { z } from 'zod';

import { parseSseBlock } from '@/lib/api/sse-parser';
import {
  citationSchema,
  pendingApprovalSchema,
  toolCallTraceSchema,
} from '@/lib/validations/orchestration';

const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

const sideEffectModelUsageSchema = z.object({
  kind: z.enum(['embedding', 'summarizer']),
  model: z.string(),
  provider: z.string().optional(),
  callCount: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
});

const inputBreakdownPartSchema = z.object({
  tokens: z.number(),
  chars: z.number(),
  content: z.string().optional(),
});

const inputBreakdownSchema = z.object({
  systemPrompt: inputBreakdownPartSchema,
  contextBlock: inputBreakdownPartSchema.optional(),
  userMemories: inputBreakdownPartSchema.extend({ count: z.number() }).optional(),
  conversationSummary: inputBreakdownPartSchema.optional(),
  conversationHistory: inputBreakdownPartSchema
    .extend({ messageCount: z.number(), droppedCount: z.number() })
    .optional(),
  toolDefinitions: inputBreakdownPartSchema
    .extend({ count: z.number(), names: z.array(z.string()) })
    .optional(),
  attachments: z.object({ tokens: z.number(), count: z.number() }).optional(),
  userMessage: inputBreakdownPartSchema,
  framingOverhead: inputBreakdownPartSchema.optional(),
  totalEstimated: z.number(),
});

const capabilityResultEntrySchema = z.object({
  capabilitySlug: z.string(),
  result: z.unknown(),
  /**
   * Admin-only diagnostic. Present iff the request opted in via
   * `includeTrace: true` and the streaming handler attached it. The
   * shape is shared with the persisted assistant-message metadata
   * (`MessageMetadata.toolCalls[]`).
   */
  trace: toolCallTraceSchema.optional(),
});

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    conversationId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({ type: z.literal('content'), delta: z.string() }),
  z.object({ type: z.literal('status'), message: z.string() }),
  z.object({ type: z.literal('content_reset'), reason: z.string().optional() }),
  z.object({
    type: z.literal('capability_result'),
    capabilitySlug: z.string(),
    result: z.unknown(),
    trace: toolCallTraceSchema.optional(),
  }),
  z.object({
    type: z.literal('capability_results'),
    results: z.array(capabilityResultEntrySchema),
  }),
  z.object({ type: z.literal('warning'), code: z.string().optional(), message: z.string() }),
  z.object({ type: z.literal('citations'), citations: z.array(citationSchema) }),
  z.object({ type: z.literal('approval_required'), pendingApproval: pendingApprovalSchema }),
  z.object({
    type: z.literal('done'),
    tokenUsage: tokenUsageSchema.optional(),
    costUsd: z.number().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    inputBreakdown: inputBreakdownSchema.optional(),
    sideEffectModels: z.array(sideEffectModelUsageSchema).optional(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);

/** Strictly typed chat stream event — discriminated by `type`. */
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

/**
 * Parse and validate one SSE block. Returns `null` for keepalives,
 * unrecognised event types, or payloads that fail validation — callers
 * should treat `null` as "ignore and move on" rather than an error.
 *
 * Logs only at debug level on validation failure to avoid spamming the
 * console when the server adds new event types ahead of the client.
 */
export function parseChatStreamEvent(block: string): ChatStreamEvent | null {
  const frame = parseSseBlock(block);
  if (!frame) return null;
  // The generic parser separates the SSE `event:` line from the data
  // payload; the Zod union expects `type` as a field, so re-merge them
  // before validation. `type` from the frame takes precedence.
  const candidate = { ...frame.data, type: frame.type };
  const parsed = chatStreamEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
