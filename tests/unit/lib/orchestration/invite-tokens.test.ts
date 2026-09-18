/**
 * Tests: lib/orchestration/invite-tokens.ts — one resolver for both routes (§106 t-673)
 *
 * The outcome vocabulary and its order; the org comparison against the org
 * the request acts in (the token never enters a context of its own); the
 * null-column rule at both modes; and the atomic consume, whose SQL is the
 * TOCTOU guard the chat route relied on before the extraction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const prismaMock = vi.hoisted(() => ({
  aiAgentInviteToken: { findFirst: vi.fn() },
  $executeRaw: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { consumeInviteToken, resolveInviteToken } from '@/lib/orchestration/invite-tokens';
import { runAsOrg } from '@/lib/tenancy/context';
import { logger } from '@/lib/logging';

const AGENT = 'cmagent0000000000000agent1';
const OTHER = 'cmorg000000000000000other';
const THIRD = 'cmorg000000000000000third';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    orgId: null,
    revokedAt: null,
    expiresAt: null,
    maxUses: null,
    useCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'single';
});

describe('resolveInviteToken', () => {
  it('selects by agent and token, and only the columns the checks need', async () => {
    prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(row());
    await resolveInviteToken(AGENT, 'abc');
    expect(prismaMock.aiAgentInviteToken.findFirst).toHaveBeenCalledWith({
      where: { agentId: AGENT, token: 'abc' },
      select: {
        id: true,
        orgId: true,
        revokedAt: true,
        expiresAt: true,
        maxUses: true,
        useCount: true,
      },
    });
  });

  it('not-found, revoked, expired, exhausted — in that order', async () => {
    prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(null);
    expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: false, reason: 'not-found' });

    prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(
      row({ revokedAt: new Date(), expiresAt: new Date(0), maxUses: 1, useCount: 1 })
    );
    expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: false, reason: 'revoked' });

    prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(
      row({ expiresAt: new Date(Date.now() - 1000), maxUses: 1, useCount: 1 })
    );
    expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: false, reason: 'expired' });

    prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(row({ maxUses: 5, useCount: 5 }));
    expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('admits a live token and hands back the row', async () => {
    const live = row({ maxUses: 5, useCount: 4, expiresAt: new Date(Date.now() + 60_000) });
    prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(live);
    expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: true, token: live });
  });

  describe('the org comparison — the token is a gate the session passes through', () => {
    it('a token from the request’s own org passes', async () => {
      prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(row({ orgId: OTHER }));
      await runAsOrg(OTHER, async () => {
        expect((await resolveInviteToken(AGENT, 'x')).ok).toBe(true);
      });
    });

    it('a token from another org is wrong-org — before revoked or expired is even looked at', async () => {
      prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(
        row({ orgId: THIRD, revokedAt: new Date() })
      );
      await runAsOrg(OTHER, async () => {
        expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: false, reason: 'wrong-org' });
      });
    });

    it('a null-org token is the install org at single: it admits a request in the install org and no other', async () => {
      prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(row());
      await runAsOrg(INSTALL_ORG_ID, async () => {
        expect((await resolveInviteToken(AGENT, 'x')).ok).toBe(true);
      });
      // No context at single is the install org too (the implicit answer).
      expect((await resolveInviteToken(AGENT, 'x')).ok).toBe(true);
      await runAsOrg(OTHER, async () => {
        expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: false, reason: 'wrong-org' });
      });
    });

    it('a null-org token matches nothing at multi — not even a request in the install org', async () => {
      mockEnv.TENANCY_MODE = 'multi';
      prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(row());
      await runAsOrg(INSTALL_ORG_ID, async () => {
        expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: false, reason: 'wrong-org' });
      });
    });

    it('at multi a request with no org matches no token — a platform admin key passes no gate — and the log names that cause', async () => {
      mockEnv.TENANCY_MODE = 'multi';
      prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(row({ orgId: OTHER }));
      expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: false, reason: 'wrong-org' });
      expect(logger.warn).toHaveBeenCalledWith(
        'invite token refused: the request acts in no org',
        expect.objectContaining({ refused: 'no-request-org', tokenId: 'tok-1' })
      );
    });

    it('a plain wrong-org refusal is not logged as the no-org case', async () => {
      prismaMock.aiAgentInviteToken.findFirst.mockResolvedValue(row({ orgId: THIRD }));
      await runAsOrg(OTHER, async () => {
        expect(await resolveInviteToken(AGENT, 'x')).toEqual({ ok: false, reason: 'wrong-org' });
      });
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});

describe('consumeInviteToken', () => {
  it('increments only while under the cap, in one statement', async () => {
    prismaMock.$executeRaw.mockResolvedValue(1);
    expect(await consumeInviteToken('tok-1')).toBe(true);

    const [strings, ...values] = prismaMock.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    expect(sql).toBe(
      'UPDATE ai_agent_invite_token SET use_count = use_count + 1 WHERE id = ? AND (max_uses IS NULL OR use_count < max_uses)'
    );
    expect(values).toEqual(['tok-1']);
  });

  it('reports a cap reached between the read and the write', async () => {
    prismaMock.$executeRaw.mockResolvedValue(0);
    expect(await consumeInviteToken('tok-1')).toBe(false);
  });
});
