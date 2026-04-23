/**
 * Integration Test: Bulk agent operations
 *
 * POST /api/v1/admin/orchestration/agents/bulk
 *
 * Applies activate, deactivate, or delete actions to multiple agents.
 * System agents are excluded from all mutations.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/agents/bulk/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_IDS = ['cmjbv4i3x00003wsloputgwu1', 'cmjbv4i3x00003wsloputgwu2'];

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/v1/admin/orchestration/agents/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/agents/bulk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.aiAgent.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it('returns 401 for unauthenticated user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await POST(makeRequest({ action: 'activate', agentIds: AGENT_IDS }));
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser());
    const res = await POST(makeRequest({ action: 'activate', agentIds: AGENT_IDS }));
    expect(res.status).toBe(403);
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('returns 400 for invalid action', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await POST(makeRequest({ action: 'explode', agentIds: AGENT_IDS }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when agentIds is empty', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await POST(makeRequest({ action: 'activate', agentIds: [] }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when agentIds contains invalid IDs', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await POST(makeRequest({ action: 'activate', agentIds: ['not-a-cuid'] }));
    expect(res.status).toBe(400);
  });

  // ── Activate ──────────────────────────────────────────────────────────────

  it('activates selected agents, excluding system agents', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await POST(makeRequest({ action: 'activate', agentIds: AGENT_IDS }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ action: 'activate', requested: 2, affected: 2 });

    const call = (prisma.aiAgent.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.id.in).toEqual(AGENT_IDS);
    expect(call.where.isSystem).toBe(false);
    expect(call.data.isActive).toBe(true);
  });

  // ── Deactivate ────────────────────────────────────────────────────────────

  it('deactivates selected agents', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await POST(makeRequest({ action: 'deactivate', agentIds: AGENT_IDS }));
    expect(res.status).toBe(200);

    const call = (prisma.aiAgent.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.isActive).toBe(false);
  });

  // ── Delete (soft) ─────────────────────────────────────────────────────────

  it('soft-deletes selected agents by setting isActive to false', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await POST(makeRequest({ action: 'delete', agentIds: AGENT_IDS }));
    expect(res.status).toBe(200);

    const call = (prisma.aiAgent.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.isSystem).toBe(false);
    expect(call.data.isActive).toBe(false);
  });

  // ── Affected count ────────────────────────────────────────────────────────

  it('returns correct affected count when some agents are system', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    (prisma.aiAgent.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    const res = await POST(makeRequest({ action: 'activate', agentIds: AGENT_IDS }));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ requested: 2, affected: 1 });
  });
});
