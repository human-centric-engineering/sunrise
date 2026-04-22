/**
 * Integration Test: Admin Orchestration — Agent Version Restore
 *
 * POST /api/v1/admin/orchestration/agents/:id/versions/:versionId/restore
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/versions/[versionId]/restore/route.ts
 *
 * Key assertions:
 * - Restores agent from version snapshot
 * - Returns 404 for invalid version
 * - Creates new version entry for the restore
 * - Admin auth required
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/agents/[id]/versions/[versionId]/restore/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => {
  const agentMocks = { findUnique: vi.fn(), update: vi.fn() };
  const versionMocks = { findFirst: vi.fn(), create: vi.fn() };
  return {
    prisma: {
      aiAgent: agentMocks,
      aiAgentVersion: versionMocks,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ aiAgent: agentMocks, aiAgentVersion: versionMocks })
      ),
    },
  };
});

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu1';
const VERSION_ID = 'cmjbv4i3x00003wsloputgwu2';

const SNAPSHOT = {
  systemInstructions: 'Old instructions',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  temperature: 0.5,
  maxTokens: 2048,
  topicBoundaries: ['finance'],
  brandVoiceInstructions: 'Be formal',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/versions/${VERSION_ID}/restore`,
    { method: 'POST' }
  );
}

const routeContext = {
  params: Promise.resolve({ id: AGENT_ID, versionId: VERSION_ID }),
};

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/agents/:id/versions/:versionId/restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makeRequest(), routeContext as never);

    expect(response.status).toBe(401);
  });

  it('returns 403 when non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await POST(makeRequest(), routeContext as never);

    expect(response.status).toBe(403);
  });

  it('restores agent from version snapshot', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
    vi.mocked(prisma.aiAgentVersion.findFirst)
      // First call: find the version to restore
      .mockResolvedValueOnce({
        id: VERSION_ID,
        agentId: AGENT_ID,
        version: 3,
        snapshot: SNAPSHOT,
      } as never)
      // Second call: find last version number
      .mockResolvedValueOnce({ version: 5 } as never);
    vi.mocked(prisma.aiAgent.update).mockResolvedValue({
      id: AGENT_ID,
      ...SNAPSHOT,
    } as never);
    vi.mocked(prisma.aiAgentVersion.create).mockResolvedValue({} as never);

    const response = await POST(makeRequest(), routeContext as never);

    expect(response.status).toBe(200);
    const body = await parseJson<{
      success: boolean;
      data: { restoredFromVersion: number; newVersion: number };
    }>(response);
    expect(body.success).toBe(true);
    expect(body.data.restoredFromVersion).toBe(3);
    expect(body.data.newVersion).toBe(6);

    // Verify agent was updated with snapshot values
    expect(prisma.aiAgent.update).toHaveBeenCalledWith({
      where: { id: AGENT_ID },
      data: expect.objectContaining({
        systemInstructions: 'Old instructions',
        model: 'claude-sonnet-4-6',
        temperature: 0.5,
      }),
    });

    // Verify new version was created
    expect(prisma.aiAgentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentId: AGENT_ID,
        version: 6,
        changeSummary: 'Restored from version 3',
      }),
    });
  });

  it('returns 404 for invalid version', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: AGENT_ID } as never);
    vi.mocked(prisma.aiAgentVersion.findFirst).mockResolvedValue(null);

    const response = await POST(makeRequest(), routeContext as never);

    expect(response.status).toBe(404);
  });
});
