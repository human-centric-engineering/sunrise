/**
 * Tests: send_message_to_channel capability.
 *
 * Covers every typed error path (no_inbound_channel, recipient_opted_out,
 * whatsapp_window_expired_template_required, message_too_long,
 * per_recipient_rate_limit_exceeded, provider_not_registered,
 * provider_channel_unsupported, provider_config_missing, invalid_binding,
 * force_provider_not_allowed), idempotency dedup, cost logging, PII
 * redaction, force-provider audit.
 *
 * Mocks Prisma + the outbound registry + logCost + logAdminAction so
 * the capability contract is exercised without DB / network / audit-row
 * side-effects. Per-adapter HTTP is covered separately in the adapter
 * test files.
 *
 * @see lib/orchestration/capabilities/built-in/send-message-to-channel.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: { findUnique: vi.fn() },
    aiAgentCapability: { findFirst: vi.fn() },
    aiOutboundMessage: {
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/outbound/bootstrap', () => ({
  bootstrapOutboundAdapters: vi.fn(),
}));

vi.mock('@/lib/orchestration/outbound/registry', () => ({
  getOutboundAdapter: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn(async () => null),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { getOutboundAdapter } from '@/lib/orchestration/outbound/registry';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { SendMessageToChannelCapability } from '@/lib/orchestration/capabilities/built-in/send-message-to-channel';
import { OutboundSendError } from '@/lib/orchestration/outbound/types';
import { CostOperation } from '@/types/orchestration';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const NOW = 1_714_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeCapability(): SendMessageToChannelCapability {
  return new SendMessageToChannelCapability();
}

function makeContext(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    agentId: 'agent-1',
    userId: 'user-1',
    conversationId: 'conv-1',
    ...overrides,
  } as CapabilityContext;
}

function setConversation(
  overrides: Partial<{
    id: string;
    channel: string | null;
    provider: string | null;
    fromAddress: string | null;
    lastInboundAt: Date | null;
    smsOptedOut: boolean;
  }> = {}
) {
  vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
    id: 'conv-1',
    channel: 'sms',
    provider: 'twilio',
    fromAddress: '+12133734253',
    lastInboundAt: new Date(NOW - 5 * 60_000), // 5 minutes ago
    smsOptedOut: false,
    ...overrides,
  } as never);
}

function setBinding(customConfig: unknown) {
  vi.mocked(prisma.aiAgentCapability.findFirst).mockResolvedValue({
    customConfig,
  } as never);
}

function defaultCustomConfig() {
  return {
    providers: {
      twilio: {
        accountSidEnv: 'TWILIO_ACCOUNT_SID',
        authTokenEnv: 'TWILIO_AUTH_TOKEN',
        fromNumberSms: '+12025550100',
        costPerMessageUsd: 0.0075,
      },
    },
  };
}

interface StubAdapterOverrides {
  provider?: string;
  supportedChannels?: readonly string[];
  send?: ReturnType<typeof vi.fn>;
}

function stubAdapter(overrides: StubAdapterOverrides = {}) {
  const send: ReturnType<typeof vi.fn> =
    overrides.send ??
    vi.fn(async () => ({
      transactionId: 'SMabc',
      statusCode: 201,
      vendorRaw: { sid: 'SMabc' },
    }));
  vi.mocked(getOutboundAdapter).mockReturnValue({
    provider: overrides.provider ?? 'twilio',
    supportedChannels: (overrides.supportedChannels ?? ['sms', 'whatsapp']) as never,
    configSchema: z.object({}).passthrough(),
    send,
  } as never);
  return send;
}

function defaultArgs() {
  return { conversationId: 'conv-1', message: 'hello' };
}

// ─── Successful path ─────────────────────────────────────────────────────────

describe('SendMessageToChannelCapability — happy path', () => {
  it('dispatches via the resolved provider adapter and logs cost', async () => {
    setConversation();
    setBinding(defaultCustomConfig());
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOutboundMessage.create).mockResolvedValue({} as never);
    vi.mocked(prisma.aiOutboundMessage.update).mockResolvedValue({} as never);
    const send = stubAdapter();

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const sendCall = send.mock.calls[0];
    expect(sendCall[0]).toMatchObject({
      to: '+12133734253',
      channel: 'sms',
      body: 'hello',
    });
    expect(sendCall[1]).toMatchObject({
      id: 'conv-1',
      channel: 'sms',
      provider: 'twilio',
    });

    // Cost log under the new enum
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: CostOperation.OUTBOUND_MESSAGE,
        provider: 'twilio',
        metadata: expect.objectContaining({ channel: 'sms', provider: 'twilio' }),
      })
    );

    // Ledger row marked sent
    expect(prisma.aiOutboundMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'sent', transactionId: 'SMabc' }),
      })
    );
  });
});

// ─── Conversation-level error paths ──────────────────────────────────────────

describe('SendMessageToChannelCapability — guard rails', () => {
  it('returns conversation_not_found when conversation does not exist', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null as never);
    setBinding(defaultCustomConfig());

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('conversation_not_found');
  });

  it('returns no_inbound_channel when conversation lacks channel/provider/fromAddress', async () => {
    setConversation({ channel: null, provider: null, fromAddress: null });
    setBinding(defaultCustomConfig());

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('no_inbound_channel');
  });

  it('treats an unrecognised channel value on the conversation row as no_inbound_channel (defensive runtime narrow)', async () => {
    // The DB column is `String?` — a typo, future migration, or direct
    // SQL write could put an unrecognised value there. The capability
    // must NOT pass that through to an adapter; `narrowConversationChannel`
    // returns null for any non-union string, mapping cleanly to
    // `no_inbound_channel`.
    setConversation({ channel: 'fax-machine' as never, provider: 'twilio' });
    setBinding(defaultCustomConfig());

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('no_inbound_channel');
  });

  it('returns recipient_opted_out when smsOptedOut is true + audit-logs the refusal', async () => {
    setConversation({ smsOptedOut: true });
    setBinding(defaultCustomConfig());

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('recipient_opted_out');
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'send_message.refused_opted_out',
        entityId: 'conv-1',
      })
    );
  });

  it('returns whatsapp_window_expired_template_required when 24h elapsed + no template', async () => {
    setConversation({
      channel: 'whatsapp',
      provider: 'meta',
      lastInboundAt: new Date(NOW - 25 * 60 * 60 * 1000), // 25h ago
    });
    setBinding({
      providers: {
        meta: { accessTokenEnv: 'X', phoneNumberId: 'P', costPerMessageUsd: 0.005 },
      },
    });
    stubAdapter({ provider: 'meta', supportedChannels: ['whatsapp'] });

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('whatsapp_window_expired_template_required');
  });

  it('accepts WA dispatch outside the 24h window when a template is supplied', async () => {
    setConversation({
      channel: 'whatsapp',
      provider: 'meta',
      lastInboundAt: new Date(NOW - 25 * 60 * 60 * 1000),
    });
    setBinding({
      providers: {
        meta: { accessTokenEnv: 'X', phoneNumberId: 'P' },
      },
    });
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOutboundMessage.create).mockResolvedValue({} as never);
    vi.mocked(prisma.aiOutboundMessage.update).mockResolvedValue({} as never);
    const send = stubAdapter({ provider: 'meta', supportedChannels: ['whatsapp'] });

    const result = await makeCapability().execute(
      { ...defaultArgs(), template: { name: 'appointment_reminder', languageCode: 'en_GB' } },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        template: { name: 'appointment_reminder', languageCode: 'en_GB' },
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('returns message_too_long when SMS body > 1600 chars', async () => {
    setConversation({ channel: 'sms', provider: 'twilio' });
    setBinding(defaultCustomConfig());

    const result = await makeCapability().execute(
      { conversationId: 'conv-1', message: 'a'.repeat(1601) },
      makeContext()
    );

    expect(result.error?.code).toBe('message_too_long');
  });

  it('returns per_recipient_rate_limit_exceeded when count >= cap', async () => {
    setConversation();
    setBinding({ ...defaultCustomConfig(), throttle: { perConversationPerHour: 3 } });
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(3);

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('per_recipient_rate_limit_exceeded');
  });
});

// ─── Adapter-resolution failure paths ────────────────────────────────────────

describe('SendMessageToChannelCapability — adapter resolution', () => {
  it('returns provider_not_registered when no adapter is registered', async () => {
    setConversation();
    setBinding(defaultCustomConfig());
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOutboundMessage.create).mockResolvedValue({} as never);
    vi.mocked(prisma.aiOutboundMessage.update).mockResolvedValue({} as never);
    vi.mocked(getOutboundAdapter).mockReturnValue(undefined);

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('provider_not_registered');
    // Ledger row marked failed (not left dangling as pending)
    expect(prisma.aiOutboundMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) })
    );
  });

  it('returns provider_channel_unsupported when adapter does not handle the channel', async () => {
    setConversation({ channel: 'sms', provider: 'meta' });
    setBinding({ providers: { meta: { accessTokenEnv: 'X', phoneNumberId: 'P' } } });
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOutboundMessage.create).mockResolvedValue({} as never);
    vi.mocked(prisma.aiOutboundMessage.update).mockResolvedValue({} as never);
    // Meta adapter only does whatsapp; conversation is sms.
    stubAdapter({ provider: 'meta', supportedChannels: ['whatsapp'] });

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('provider_channel_unsupported');
  });

  it('returns provider_config_missing when customConfig has no block for the provider', async () => {
    setConversation();
    setBinding({ providers: {} });
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOutboundMessage.create).mockResolvedValue({} as never);
    vi.mocked(prisma.aiOutboundMessage.update).mockResolvedValue({} as never);
    stubAdapter();

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('provider_config_missing');
  });

  it('maps OutboundSendError thrown by the adapter into a typed error result', async () => {
    setConversation();
    setBinding(defaultCustomConfig());
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOutboundMessage.create).mockResolvedValue({} as never);
    vi.mocked(prisma.aiOutboundMessage.update).mockResolvedValue({} as never);
    stubAdapter({
      send: vi.fn(async () => {
        throw new OutboundSendError('vendor_unauthorized', 'auth failed', 401);
      }),
    });

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('vendor_unauthorized');
    expect(result.error?.message).toMatch(/auth failed/);
  });
});

// ─── customConfig validation ─────────────────────────────────────────────────

describe('SendMessageToChannelCapability — customConfig validation', () => {
  it('returns invalid_binding when customConfig is malformed', async () => {
    setConversation();
    setBinding({ providers: 'not-an-object' });

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('invalid_binding');
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('SendMessageToChannelCapability — idempotency', () => {
  it('returns the cached transactionId on UNIQUE collision (P2002)', async () => {
    setConversation();
    setBinding(defaultCustomConfig());
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOutboundMessage.create).mockRejectedValue({ code: 'P2002' } as never);
    vi.mocked(prisma.aiOutboundMessage.findUnique).mockResolvedValue({
      transactionId: 'SMcached',
      status: 'sent',
    } as never);
    const send = stubAdapter();

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.success).toBe(true);
    expect(result.data?.transactionId).toBe('SMcached');
    expect(result.data?.deduplicated).toBe(true);
    // The adapter MUST NOT have been called — the dispatch is deduplicated.
    expect(send).not.toHaveBeenCalled();
  });

  it('returns duplicate_dispatch_in_flight when collision row has no transactionId yet', async () => {
    setConversation();
    setBinding(defaultCustomConfig());
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOutboundMessage.create).mockRejectedValue({ code: 'P2002' } as never);
    vi.mocked(prisma.aiOutboundMessage.findUnique).mockResolvedValue({
      transactionId: null,
      status: 'pending',
    } as never);

    const result = await makeCapability().execute(defaultArgs(), makeContext());

    expect(result.error?.code).toBe('duplicate_dispatch_in_flight');
  });
});

// ─── forceProvider ───────────────────────────────────────────────────────────

describe('SendMessageToChannelCapability — forceProvider', () => {
  it('refuses forceProvider when allowForceProvider is not set', async () => {
    setConversation();
    setBinding(defaultCustomConfig());

    const result = await makeCapability().execute(
      { ...defaultArgs(), forceProvider: 'meta' },
      makeContext()
    );

    expect(result.error?.code).toBe('force_provider_not_allowed');
  });

  it('honours forceProvider when allowForceProvider is true + writes an audit row', async () => {
    setConversation(); // recorded: twilio
    setBinding({
      ...defaultCustomConfig(),
      allowForceProvider: true,
      providers: {
        twilio: defaultCustomConfig().providers.twilio,
        meta: { accessTokenEnv: 'X', phoneNumberId: 'P' },
      },
    });
    vi.mocked(prisma.aiOutboundMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOutboundMessage.create).mockResolvedValue({} as never);
    vi.mocked(prisma.aiOutboundMessage.update).mockResolvedValue({} as never);
    stubAdapter({ provider: 'meta', supportedChannels: ['sms', 'whatsapp'] });

    const result = await makeCapability().execute(
      { ...defaultArgs(), forceProvider: 'meta' },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'send_message.force_provider',
        metadata: expect.objectContaining({
          recordedProvider: 'twilio',
          forcedProvider: 'meta',
        }),
      })
    );
  });
});

// ─── PII redaction ───────────────────────────────────────────────────────────

describe('SendMessageToChannelCapability — redactProvenance', () => {
  it('replaces message body with a sentinel preserving only length', () => {
    const cap = makeCapability();
    const redaction = cap.redactProvenance(
      { conversationId: 'conv-1', message: 'Hi Alice, your appointment is confirmed' },
      {
        success: true,
        data: {
          transactionId: 'SM1',
          channel: 'sms',
          provider: 'twilio',
          statusCode: 201,
          deduplicated: false,
        },
      }
    );
    const args = redaction.args as Record<string, unknown>;
    expect(args.conversationId).toBe('conv-1');
    expect(args.message).toMatch(/redacted/);
    expect(args.message).toMatch(/\d+ chars/);
    // Result preview keeps structural fields, drops body.
    expect(redaction.resultPreview).toContain('SM1');
    expect(redaction.resultPreview).not.toContain('Alice');
  });

  it('redacts an explicit idempotencyKey to avoid leaking a derived secret', () => {
    const cap = makeCapability();
    const redaction = cap.redactProvenance(
      { conversationId: 'conv-1', message: 'hi', idempotencyKey: 'secret-key-123' },
      {
        success: true,
        data: {
          transactionId: 'SM1',
          channel: 'sms',
          provider: 'twilio',
          statusCode: 201,
          deduplicated: false,
        },
      }
    );
    const args = redaction.args as Record<string, unknown>;
    expect(args.idempotencyKey).toMatch(/redacted/);
    expect(args.idempotencyKey).not.toContain('secret-key-123');
  });
});
