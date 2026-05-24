/**
 * Tests: conversation resolver — find-or-create + STOP/START reconciliation
 * + provider-swap continuity + concurrent-inbound race-loser path.
 *
 * Mocks Prisma so the (agentId, channel, fromAddress) unique-key lookups,
 * creates, and updates are exercised without DB side-effects.
 *
 * @see lib/orchestration/inbound/conversation-resolver.ts
 */

import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { resolveConversation } from '@/lib/orchestration/inbound/conversation-resolver';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function defaultArgs(overrides: Partial<Parameters<typeof resolveConversation>[0]> = {}) {
  return {
    agentId: 'agent-1',
    userId: 'user-1',
    channel: 'sms' as const,
    provider: 'twilio',
    fromAddress: '+12133734253',
    text: 'hi there',
    ...overrides,
  };
}

// ─── Create path ─────────────────────────────────────────────────────────────

describe('resolveConversation — create new', () => {
  it('creates a new conversation when none exists for (agentId, channel, fromAddress)', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.aiConversation.create).mockResolvedValue({ id: 'conv-new' } as never);

    const result = await resolveConversation(defaultArgs());

    expect(result.wasCreated).toBe(true);
    expect(result.conversationId).toBe('conv-new');
    expect(result.optOutStateChanged).toBe(false);
    expect(prisma.aiConversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentId: 'agent-1',
        userId: 'user-1',
        channel: 'sms',
        provider: 'twilio',
        fromAddress: '+12133734253',
        smsOptedOut: false,
      }),
      select: { id: true },
    });
  });

  it('creates with smsOptedOut=true when the first message is a STOP keyword', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.aiConversation.create).mockResolvedValue({ id: 'conv-new' } as never);

    const result = await resolveConversation(defaultArgs({ text: 'STOP' }));

    expect(result.optOutStateChanged).toBe(true);
    expect(prisma.aiConversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ smsOptedOut: true }),
      select: { id: true },
    });
  });
});

// ─── Reuse existing ──────────────────────────────────────────────────────────

describe('resolveConversation — reuse existing', () => {
  it('finds and updates lastInboundAt without changing the opt-out flag', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv-existing',
      smsOptedOut: false,
      provider: 'twilio',
    } as never);
    vi.mocked(prisma.aiConversation.update).mockResolvedValue({} as never);

    const result = await resolveConversation(defaultArgs());

    expect(result.wasCreated).toBe(false);
    expect(result.conversationId).toBe('conv-existing');
    expect(result.optOutStateChanged).toBe(false);
    expect(prisma.aiConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-existing' },
      data: expect.objectContaining({ lastInboundAt: expect.any(Date) }),
    });
    expect(prisma.aiConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ provider: expect.anything() }),
      })
    );
  });

  it('reconciles smsOptedOut and writes an audit log on STOP', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv-1',
      smsOptedOut: false,
      provider: 'twilio',
    } as never);
    vi.mocked(prisma.aiConversation.update).mockResolvedValue({} as never);

    const result = await resolveConversation(defaultArgs({ text: 'STOP please' }));

    expect(result.optOutStateChanged).toBe(true);
    expect(prisma.aiConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ smsOptedOut: true }),
      })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'inbound.opt_out_recorded' })
    );
  });

  it('reconciles smsOptedOut=false and writes an opt-in audit log on START', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv-1',
      smsOptedOut: true,
      provider: 'twilio',
    } as never);
    vi.mocked(prisma.aiConversation.update).mockResolvedValue({} as never);

    const result = await resolveConversation(defaultArgs({ text: 'START' }));

    expect(result.optOutStateChanged).toBe(true);
    expect(prisma.aiConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ smsOptedOut: false }),
      })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'inbound.opt_in_recorded' })
    );
  });

  it('does NOT log audit / change flag when opt-state matches existing (idempotent STOP)', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv-1',
      smsOptedOut: true,
      provider: 'twilio',
    } as never);
    vi.mocked(prisma.aiConversation.update).mockResolvedValue({} as never);

    const result = await resolveConversation(defaultArgs({ text: 'STOP' }));

    expect(result.optOutStateChanged).toBe(false);
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

// ─── Concurrent inbound — race loser path ────────────────────────────────────

describe('resolveConversation — concurrent inbound race', () => {
  it('catches P2002 on create and re-reads the conversation the racing inbound just wrote', async () => {
    // Two inbound webhooks for the same (agentId, channel, fromAddress)
    // arrive within ms of each other. Both findUnique calls miss; our
    // create loses the race and hits P2002 on the @@unique. The resolver
    // must NOT throw — it must re-fetch and reuse the racing row, so the
    // STOP/opt-out flag always lands on the same row regardless of which
    // request wins. Without the race-loser path, the loser would create
    // a duplicate conversation and subsequent outbound could load the
    // wrong row (still opted-in) → TCPA/PECR violation.
    vi.mocked(prisma.aiConversation.findUnique)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        id: 'conv-from-race',
        smsOptedOut: false,
        provider: 'twilio',
      } as never);

    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '7.0.0',
    });
    vi.mocked(prisma.aiConversation.create).mockRejectedValue(p2002 as never);
    vi.mocked(prisma.aiConversation.update).mockResolvedValue({} as never);

    const result = await resolveConversation(defaultArgs({ text: 'STOP' }));

    expect(result.wasCreated).toBe(false);
    expect(result.conversationId).toBe('conv-from-race');
    expect(result.optOutStateChanged).toBe(true);
    expect(prisma.aiConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv-from-race' },
        data: expect.objectContaining({ smsOptedOut: true }),
      })
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'inbound.opt_out_recorded' })
    );
  });

  it('re-throws non-P2002 errors from create (e.g. DB connection failure)', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.aiConversation.create).mockRejectedValue(
      new Error('connection refused') as never
    );

    await expect(resolveConversation(defaultArgs())).rejects.toThrow('connection refused');
  });
});

// ─── Provider swap continuity ────────────────────────────────────────────────

describe('resolveConversation — provider swap continuity', () => {
  it('updates the provider column when an existing conversation arrives via a different provider', async () => {
    // A user previously messaged via Twilio; partner now uses Vonage.
    // Same channel + fromAddress → reuse conversation, update provider.
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      id: 'conv-existing',
      smsOptedOut: false,
      provider: 'twilio',
    } as never);
    vi.mocked(prisma.aiConversation.update).mockResolvedValue({} as never);

    const result = await resolveConversation(defaultArgs({ provider: 'vonage' }));

    expect(result.wasCreated).toBe(false);
    expect(result.conversationId).toBe('conv-existing');
    expect(prisma.aiConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-existing' },
      data: expect.objectContaining({ provider: 'vonage' }),
    });
  });
});
