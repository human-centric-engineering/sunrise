/**
 * Unit Test: System agent protection (DELETE / PATCH)
 *
 * Tests that system agents (isSystem: true) cannot be deleted or
 * deactivated, and that editing system agent instructions returns
 * a warning header.
 *
 * Test Coverage:
 * - DELETE rejects system agents with 403
 * - DELETE allows non-system agents
 * - PATCH rejects isActive: false on system agents with 403
 * - PATCH allows isActive: false on non-system agents
 * - PATCH returns X-System-Warning header when editing system agent instructions
 * - PATCH does not return X-System-Warning for non-system agents
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE, PATCH } from '@/app/api/v1/admin/orchestration/agents/[id]/route';
import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';

function makeSystemAgent(overrides = {}) {
  return {
    id: AGENT_ID,
    name: 'Pattern Advisor',
    slug: 'pattern-advisor',
    description: 'System agent',
    systemInstructions: 'You are the Pattern Advisor.',
    systemInstructionsHistory: [],
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    isActive: true,
    isSystem: true,
    createdBy: 'admin-id',
    ...overrides,
  };
}

function makeCustomAgent(overrides = {}) {
  return {
    ...makeSystemAgent({ isSystem: false, slug: 'custom-agent', name: 'Custom Agent' }),
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeleteRequest(): NextRequest {
  return {
    method: 'DELETE',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}`,
  } as unknown as NextRequest;
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'PATCH',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}`,
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('System agent protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  describe('DELETE', () => {
    it('rejects deletion of system agents with 403', async () => {
      mockFindUnique.mockResolvedValue(makeSystemAgent());

      const response = await DELETE(makeDeleteRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('System agents cannot be deleted');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('allows deletion of non-system agents', async () => {
      const agent = makeCustomAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue({ ...agent, isActive: false });

      const response = await DELETE(makeDeleteRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data.isActive).toBe(false);
    });
  });

  describe('PATCH — deactivation guard', () => {
    it('rejects isActive: false on system agents with 403', async () => {
      mockFindUnique.mockResolvedValue(makeSystemAgent());

      const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('System agents cannot be deactivated');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('allows isActive: false on non-system agents', async () => {
      const agent = makeCustomAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue({ ...agent, isActive: false });

      const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
    });
  });

  describe('PATCH — system instruction warning', () => {
    it('returns X-System-Warning header when editing system agent instructions', async () => {
      const agent = makeSystemAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue({
        ...agent,
        systemInstructions: 'Updated instructions.',
      });

      const response = await PATCH(
        makePatchRequest({ systemInstructions: 'Updated instructions.' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-System-Warning')).toBeTruthy();
    });

    it('does not return X-System-Warning for non-system agents', async () => {
      const agent = makeCustomAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue({
        ...agent,
        systemInstructions: 'Updated instructions.',
      });

      const response = await PATCH(
        makePatchRequest({ systemInstructions: 'Updated instructions.' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-System-Warning')).toBeNull();
    });
  });
});
