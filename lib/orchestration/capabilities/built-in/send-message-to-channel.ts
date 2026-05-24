/**
 * `send_message_to_channel` capability — reply on the channel the user
 * came in on.
 *
 * Thin delegate: loads `AiConversation.(channel, provider, fromAddress,
 * lastInboundAt, smsOptedOut)`, runs the cross-vendor guards (STOP-flag,
 * WhatsApp 24h window, length cap, per-recipient throttle, outbound
 * idempotency, PII redaction), and delegates the actual vendor API
 * dispatch to the `OutboundAdapter` registered for the conversation's
 * provider. Adding a new SMS / WhatsApp provider in future is a new
 * adapter file + bootstrap line — this capability is provider-agnostic.
 *
 * See `.context/orchestration/recipes/sms-whatsapp-inbound-reply.md`
 * for the operator-facing setup guide and the `customConfig` JSON shape.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  BaseCapability,
  type ProvenanceRedaction,
} from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
  CapabilitySchema,
} from '@/lib/orchestration/capabilities/types';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { bootstrapOutboundAdapters } from '@/lib/orchestration/outbound/bootstrap';
import { getOutboundAdapter } from '@/lib/orchestration/outbound/registry';
import {
  OutboundSendError,
  type ConversationContext as OutboundConversationContext,
  type OutboundMessageRequest,
} from '@/lib/orchestration/outbound/types';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import type { ConversationChannel } from '@/lib/orchestration/inbound/types';
import { CostOperation } from '@/types/orchestration';
import { redactedString } from '@/lib/security/redact';

const SLUG = 'send_message_to_channel';

// Length caps mirror vendor documented limits. SMS is 1600 incl.
// concatenation; WhatsApp text body is 4096.
const SMS_MAX_LENGTH = 1600;
const WHATSAPP_MAX_LENGTH = 4096;
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PER_CONVERSATION_PER_HOUR = 5;

// ─── Args schema ─────────────────────────────────────────────────────────────

const argsSchema = z
  .object({
    conversationId: z.string().min(1, 'conversationId is required'),
    message: z
      .string()
      .min(1, 'message cannot be empty')
      .max(4096, 'message exceeds the maximum supported length (4096 chars)'),
    /**
     * Admin override — only honoured when customConfig.allowForceProvider
     * is true. Used for migrating an end user from one provider to another.
     */
    forceProvider: z.string().min(1).optional(),
    template: z
      .object({
        name: z.string().min(1),
        languageCode: z.string().min(2),
        components: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

interface Data {
  transactionId: string;
  channel: ConversationChannel;
  provider: string;
  statusCode: number;
  deduplicated: boolean;
}

// ─── customConfig schema ─────────────────────────────────────────────────────

const customConfigSchema = z
  .object({
    /**
     * Per-provider config blocks. Keys are provider slugs
     * (`twilio`, `meta`, future `vonage`...) and values are validated
     * against each adapter's `configSchema` at dispatch time.
     */
    providers: z.record(z.string(), z.unknown()),
    throttle: z
      .object({
        perConversationPerHour: z.number().int().positive().max(100),
      })
      .optional(),
    allowForceProvider: z.boolean().optional(),
  })
  .strict();

type CustomConfig = z.infer<typeof customConfigSchema>;

// ─── Conversation fetch + helpers ────────────────────────────────────────────

interface LoadedConversation {
  id: string;
  channel: ConversationChannel | null;
  provider: string | null;
  fromAddress: string | null;
  lastInboundAt: Date | null;
  smsOptedOut: boolean;
}

const KNOWN_CONVERSATION_CHANNELS: ReadonlySet<ConversationChannel> = new Set([
  'sms',
  'whatsapp',
  'email',
  'slack',
  'chat',
]);

function narrowConversationChannel(value: string | null): ConversationChannel | null {
  if (value === null) return null;
  // Runtime narrow — the DB column is `String?`; a bad value (typo,
  // future migration, third-party direct DB write) should be treated
  // as "no recorded channel" rather than mis-narrowed and silently
  // dispatched to the wrong adapter.
  return KNOWN_CONVERSATION_CHANNELS.has(value as ConversationChannel)
    ? (value as ConversationChannel)
    : null;
}

async function loadConversation(conversationId: string): Promise<LoadedConversation | null> {
  const row = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      channel: true,
      provider: true,
      fromAddress: true,
      lastInboundAt: true,
      smsOptedOut: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    channel: narrowConversationChannel(row.channel),
    provider: row.provider,
    fromAddress: row.fromAddress,
    lastInboundAt: row.lastInboundAt,
    smsOptedOut: row.smsOptedOut,
  };
}

function deriveDedupKey(args: Args, conversationId: string): string {
  if (args.idempotencyKey) return `explicit:${args.idempotencyKey}`;
  const bucket = Math.floor(Date.now() / 60_000);
  const hash = createHash('sha256')
    .update(`${conversationId}|${args.message}|${bucket}`)
    .digest('hex');
  return `auto:${hash}`;
}

function maxLengthFor(channel: ConversationChannel): number | null {
  if (channel === 'sms') return SMS_MAX_LENGTH;
  if (channel === 'whatsapp') return WHATSAPP_MAX_LENGTH;
  return null;
}

// ─── Capability class ────────────────────────────────────────────────────────

export class SendMessageToChannelCapability extends BaseCapability<Args, Data> {
  readonly slug = SLUG;
  readonly processesPii = true;
  protected readonly schema: CapabilitySchema<Args> = argsSchema;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: SLUG,
    description:
      "Reply to the end-user on whichever channel they originally contacted us on (SMS, WhatsApp, or future channels). The platform automatically routes the message to the correct provider based on the conversation's recorded inbound channel. Use this when the agent needs to send a response back to a user who reached us via a third-party messaging channel.",
    parameters: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description:
            'ID of the AiConversation to reply within. The conversation row carries the channel + provider + recipient address.',
        },
        message: {
          type: 'string',
          description: 'Plain-text message body. SMS: max 1600 chars. WhatsApp: max 4096 chars.',
          maxLength: 4096,
        },
        template: {
          type: 'object',
          description:
            'WhatsApp pre-approved template — required when the 24-hour conversation window has expired. The template must be approved in Meta Business Manager before use.',
          properties: {
            name: { type: 'string' },
            languageCode: { type: 'string', description: 'BCP-47, e.g. `en_GB` or `en_US`.' },
            components: {
              type: 'array',
              description:
                'Optional template components (header / body / button parameter substitutions). See Meta Cloud API docs.',
            },
          },
          required: ['name', 'languageCode'],
        },
        idempotencyKey: {
          type: 'string',
          description:
            'Optional explicit dedup key. If omitted, the platform derives one from (conversationId, message, current-minute) so a workflow retry within the same minute does not send the message twice.',
        },
      },
      required: ['conversationId', 'message'],
    },
  };

  override redactProvenance(args: Args, result: CapabilityResult<Data>): ProvenanceRedaction {
    const safeArgs = {
      conversationId: args.conversationId,
      message: redactedString(`${args.message.length} chars`),
      ...(args.template ? { template: { name: args.template.name } } : {}),
      ...(args.idempotencyKey ? { idempotencyKey: redactedString('idempotency-key') } : {}),
      ...(args.forceProvider ? { forceProvider: args.forceProvider } : {}),
    };
    let preview: string;
    if (result.success && result.data) {
      preview = JSON.stringify({
        success: true,
        data: {
          transactionId: result.data.transactionId,
          channel: result.data.channel,
          provider: result.data.provider,
          statusCode: result.data.statusCode,
          deduplicated: result.data.deduplicated,
        },
      });
    } else {
      // Error envelope is structural — no PII risk.
      preview = JSON.stringify(result);
    }
    return { args: safeArgs, resultPreview: preview };
  }

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    // Module-level outbound bootstrap is idempotent — first execute call
    // registers any adapters whose env vars are set. Subsequent calls no-op.
    bootstrapOutboundAdapters();

    // 1. Load conversation. Missing or no channel/provider/fromAddress
    //    means the conversation never came in on an outbound-capable
    //    channel (e.g. a web embed chat) — refuse cleanly.
    const conv = await loadConversation(args.conversationId);
    if (!conv) {
      return this.error('Conversation not found', 'conversation_not_found');
    }
    const recordedChannel = conv.channel;
    const recordedProvider = conv.provider;
    if (!recordedChannel || !recordedProvider || !conv.fromAddress) {
      return this.error(
        'Conversation has no recorded inbound channel — cannot reply on an outbound channel.',
        'no_inbound_channel'
      );
    }

    // 2. Load custom config + resolve provider (with optional admin force-override).
    const customConfig = await this.loadCustomConfig(context.agentId);
    if (customConfig.kind === 'malformed') {
      logger.error('send_message_to_channel: refusing call — customConfig JSON is malformed', {
        agentId: context.agentId,
        issues: customConfig.issues,
      });
      return this.error('Capability binding is misconfigured', 'invalid_binding');
    }
    const cfg = customConfig.config;

    let providerSlug = recordedProvider;
    if (args.forceProvider && args.forceProvider !== recordedProvider) {
      if (!cfg?.allowForceProvider) {
        return this.error(
          'forceProvider is not enabled for this binding',
          'force_provider_not_allowed'
        );
      }
      providerSlug = args.forceProvider;
      // Audit-log every override — operator visibility on cross-vendor
      // dispatch is required for any partner doing regulated outreach.
      logAdminAction({
        action: 'send_message.force_provider',
        entityType: 'ai_conversation',
        entityId: conv.id,
        userId: context.userId ?? null,
        metadata: {
          recordedProvider,
          forcedProvider: providerSlug,
          channel: recordedChannel,
        },
      });
    }

    // 3. STOP-flag check.
    if (conv.smsOptedOut) {
      logAdminAction({
        action: 'send_message.refused_opted_out',
        entityType: 'ai_conversation',
        entityId: conv.id,
        userId: context.userId ?? null,
        metadata: { channel: recordedChannel, provider: providerSlug },
      });
      return this.error(
        'Recipient has opted out (STOP). No further messages will be sent.',
        'recipient_opted_out'
      );
    }

    // 4. WhatsApp 24h window — outside the window requires a template.
    if (recordedChannel === 'whatsapp') {
      const last = conv.lastInboundAt?.getTime() ?? 0;
      const windowOpen = Date.now() - last < WHATSAPP_WINDOW_MS;
      if (!windowOpen && !args.template) {
        return this.error(
          'WhatsApp 24-hour conversation window has expired. Supply an approved Meta template to continue.',
          'whatsapp_window_expired_template_required'
        );
      }
    }

    // 5. Length cap.
    const maxLength = maxLengthFor(recordedChannel);
    if (maxLength && args.message.length > maxLength) {
      return this.error(
        `Message exceeds ${recordedChannel === 'sms' ? 'SMS' : 'WhatsApp'} length cap of ${maxLength} chars (got ${args.message.length}).`,
        'message_too_long'
      );
    }

    // 6. Per-recipient throttle. Count outbound rows in the trailing hour.
    const perHourCap = cfg?.throttle?.perConversationPerHour ?? DEFAULT_PER_CONVERSATION_PER_HOUR;
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await prisma.aiOutboundMessage.count({
      where: { conversationId: conv.id, createdAt: { gte: since } },
    });
    if (recentCount >= perHourCap) {
      return this.error(
        `Per-recipient outbound rate limit exceeded (${recentCount}/${perHourCap} in trailing hour).`,
        'per_recipient_rate_limit_exceeded'
      );
    }

    // 7. Idempotency — create or return cached AiOutboundMessage.
    const dedupKey = deriveDedupKey(args, conv.id);
    try {
      await prisma.aiOutboundMessage.create({
        data: {
          conversationId: conv.id,
          dedupKey,
          channel: recordedChannel,
          provider: providerSlug,
          status: 'pending',
        },
      });
    } catch (err) {
      // Prisma P2002 unique violation = duplicate dispatch. Return cached
      // transaction id without re-dispatching.
      if (isUniqueViolation(err)) {
        const existing = await prisma.aiOutboundMessage.findUnique({ where: { dedupKey } });
        if (existing?.transactionId) {
          return this.success({
            transactionId: existing.transactionId,
            channel: recordedChannel,
            provider: providerSlug,
            statusCode: 200,
            deduplicated: true,
          });
        }
        // No cached transaction id yet — another concurrent retry is still
        // in flight. Refuse safely.
        return this.error(
          'Duplicate dispatch in flight; previous attempt has not yet recorded a transaction id.',
          'duplicate_dispatch_in_flight'
        );
      }
      throw err;
    }

    // 8. Resolve adapter.
    const adapter = getOutboundAdapter(providerSlug);
    if (!adapter) {
      await markFailed(
        dedupKey,
        'provider_not_registered',
        `No outbound adapter registered for provider "${providerSlug}"`
      );
      return this.error(
        `No outbound adapter registered for provider "${providerSlug}" — check that the provider's env vars are set.`,
        'provider_not_registered'
      );
    }
    if (!adapter.supportedChannels.includes(recordedChannel)) {
      await markFailed(
        dedupKey,
        'provider_channel_unsupported',
        `Provider "${providerSlug}" does not support channel "${recordedChannel}"`
      );
      return this.error(
        `Provider "${providerSlug}" does not support channel "${recordedChannel}".`,
        'provider_channel_unsupported'
      );
    }

    // 9. Delegate dispatch to adapter.
    const providerConfig = cfg?.providers?.[providerSlug];
    if (providerConfig === undefined) {
      await markFailed(
        dedupKey,
        'provider_config_missing',
        `customConfig.providers.${providerSlug} not configured`
      );
      return this.error(
        `customConfig.providers["${providerSlug}"] is not configured for this binding.`,
        'provider_config_missing'
      );
    }

    const outboundReq: OutboundMessageRequest = {
      to: conv.fromAddress,
      channel: recordedChannel,
      body: args.message,
      idempotencyKey: dedupKey,
      ...(args.template ? { template: args.template } : {}),
    };

    const outboundConv: OutboundConversationContext = {
      id: conv.id,
      channel: recordedChannel,
      provider: providerSlug,
      fromAddress: conv.fromAddress,
      lastInboundAt: conv.lastInboundAt,
    };

    let result;
    try {
      result = await adapter.send(outboundReq, outboundConv, providerConfig);
    } catch (err) {
      if (err instanceof OutboundSendError) {
        await markFailed(dedupKey, err.code, err.message);
        return this.error(err.message, err.code);
      }
      const message = err instanceof Error ? err.message : 'Unknown outbound error';
      await markFailed(dedupKey, 'unknown', message);
      return this.error(message, 'unknown');
    }

    // 10. Update ledger row + log cost.
    await prisma.aiOutboundMessage.update({
      where: { dedupKey },
      data: { transactionId: result.transactionId, status: 'sent' },
    });

    // Cost per message — read from the provider's config block via a
    // lightweight inspection since we have the validated schema (we
    // validated providerConfig is `unknown` at the capability layer; the
    // adapter validated again). Both adapters' schemas have an optional
    // `costPerMessageUsd` field at the top level.
    const costPerMessageUsd = extractCost(providerConfig);
    await logCost({
      agentId: context.agentId,
      conversationId: conv.id,
      provider: providerSlug,
      model: `${providerSlug}-${recordedChannel}`,
      inputTokens: 0,
      outputTokens: 0,
      operation: CostOperation.OUTBOUND_MESSAGE,
      metadata: {
        channel: recordedChannel,
        provider: providerSlug,
        transactionId: result.transactionId,
        statusCode: result.statusCode,
        idempotencyKey: dedupKey,
        usdPerMessage: costPerMessageUsd,
      },
      isLocal: true, // platform-side flag — cost USD is set explicitly via metadata, not derived
    });

    return this.success({
      transactionId: result.transactionId,
      channel: recordedChannel,
      provider: providerSlug,
      statusCode: result.statusCode,
      deduplicated: false,
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async loadCustomConfig(agentId: string): Promise<LoadCustomConfigResult> {
    const binding = await prisma.aiAgentCapability.findFirst({
      where: { agentId, capability: { slug: SLUG } },
      select: { customConfig: true },
    });
    if (!binding?.customConfig) return { kind: 'ok', config: undefined };

    const parsed = customConfigSchema.safeParse(binding.customConfig);
    if (!parsed.success) {
      return { kind: 'malformed', issues: parsed.error.issues };
    }
    return { kind: 'ok', config: parsed.data };
  }
}

type LoadCustomConfigResult =
  | { kind: 'ok'; config: CustomConfig | undefined }
  | { kind: 'malformed'; issues: ReadonlyArray<unknown> };

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P2002';
}

async function markFailed(
  dedupKey: string,
  errorCode: string,
  errorMessage: string
): Promise<void> {
  try {
    await prisma.aiOutboundMessage.update({
      where: { dedupKey },
      data: { status: 'failed', errorCode, errorMessage: errorMessage.slice(0, 1000) },
    });
  } catch (err) {
    logger.warn('send_message_to_channel: failed to mark outbound row as failed', {
      dedupKey,
      errorCode,
      logError: err instanceof Error ? err.message : String(err),
    });
  }
}

function extractCost(providerConfig: unknown): number | undefined {
  if (!providerConfig || typeof providerConfig !== 'object') return undefined;
  const cost = (providerConfig as { costPerMessageUsd?: unknown }).costPerMessageUsd;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
}

/** Test-only export. */
export const __testing = { argsSchema, customConfigSchema, deriveDedupKey };
