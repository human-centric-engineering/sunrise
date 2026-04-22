/**
 * Integration Test: Consumer Chat — Validate Invite Token
 *
 * POST /api/v1/chat/agents/:slug/validate-token
 *
 * @see app/api/v1/chat/agents/[slug]/validate-token/route.ts
 *
 * Key assertions:
 * - Returns valid for active token
 * - Returns invalid for expired token
 * - Returns invalid for revoked token
 * - Returns 401 unauthenticated
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/chat/agents/[slug]/validate-token/route';
import { mockAuthenticatedUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findFirst: vi.fn() },
    aiAgentInviteToken: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  chatLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/chat/agents/my-bot/validate-token', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const routeContext = { params: Promise.resolve({ slug: 'my-bot' }) };

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/chat/agents/:slug/validate-token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makeRequest({ inviteToken: 'tok123' }), routeContext as never);

    expect(response.status).toBe(401);
  });

  it('returns valid for active token', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      id: 'agent-1',
      visibility: 'invite_only',
    } as never);
    vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
      id: 'tok-1',
      token: 'tok123',
      revokedAt: null,
      expiresAt: null,
      maxUses: null,
      useCount: 0,
    } as never);

    const response = await POST(makeRequest({ inviteToken: 'tok123' }), routeContext as never);

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: { valid: boolean } }>(response);
    expect(body.data.valid).toBe(true);
  });

  it('returns invalid for expired token', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      id: 'agent-1',
      visibility: 'invite_only',
    } as never);
    vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
      id: 'tok-1',
      token: 'tok123',
      revokedAt: null,
      expiresAt: new Date('2020-01-01'),
      maxUses: null,
      useCount: 0,
    } as never);

    const response = await POST(makeRequest({ inviteToken: 'tok123' }), routeContext as never);

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: { valid: boolean; reason: string } }>(
      response
    );
    expect(body.data.valid).toBe(false);
    expect(body.data.reason).toBe('Token has expired');
  });

  it('returns invalid for revoked token', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      id: 'agent-1',
      visibility: 'invite_only',
    } as never);
    vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
      id: 'tok-1',
      token: 'tok123',
      revokedAt: new Date('2025-01-01'),
      expiresAt: null,
      maxUses: null,
      useCount: 0,
    } as never);

    const response = await POST(makeRequest({ inviteToken: 'tok123' }), routeContext as never);

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: { valid: boolean; reason: string } }>(
      response
    );
    expect(body.data.valid).toBe(false);
    expect(body.data.reason).toBe('Token has been revoked');
  });

  it('returns invalid for token not found', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      id: 'agent-1',
      visibility: 'invite_only',
    } as never);
    vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue(null);

    const response = await POST(makeRequest({ inviteToken: 'bad-token' }), routeContext as never);

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: { valid: boolean; reason: string } }>(
      response
    );
    expect(body.data.valid).toBe(false);
    expect(body.data.reason).toBe('Token not found');
  });

  it('returns invalid when token has reached usage limit', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    vi.mocked(prisma.aiAgent.findFirst).mockResolvedValue({
      id: 'agent-1',
      visibility: 'invite_only',
    } as never);
    vi.mocked(prisma.aiAgentInviteToken.findFirst).mockResolvedValue({
      id: 'tok-1',
      token: 'tok123',
      revokedAt: null,
      expiresAt: null,
      maxUses: 5,
      useCount: 5,
    } as never);

    const response = await POST(makeRequest({ inviteToken: 'tok123' }), routeContext as never);

    expect(response.status).toBe(200);
    const body = await parseJson<{ success: boolean; data: { valid: boolean; reason: string } }>(
      response
    );
    expect(body.data.valid).toBe(false);
    expect(body.data.reason).toBe('Token has reached its usage limit');
  });
});
