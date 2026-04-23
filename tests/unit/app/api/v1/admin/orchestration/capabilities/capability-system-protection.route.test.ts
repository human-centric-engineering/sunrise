/**
 * Unit Test: System capability protection (DELETE / PATCH)
 *
 * Tests that system capabilities (isSystem: true) cannot be deleted
 * or deactivated via the admin API.
 *
 * Test Coverage:
 * - DELETE rejects system capabilities with 403
 * - DELETE allows non-system capabilities
 * - PATCH rejects isActive: false on system capabilities with 403
 * - PATCH allows isActive: false on non-system capabilities
 *
 * @see app/api/v1/admin/orchestration/capabilities/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE, PATCH } from '@/app/api/v1/admin/orchestration/capabilities/[id]/route';
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
    aiCapability: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({
  capabilityDispatcher: { clearCache: vi.fn() },
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

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => null),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CAP_ID = 'cmjbv4i3x00003wsloputgwul';

function makeSystemCapability(overrides = {}) {
  return {
    id: CAP_ID,
    name: 'Search Knowledge Base',
    slug: 'search_knowledge_base',
    description: 'Semantic search over the knowledge base.',
    category: 'knowledge',
    functionDefinition: { name: 'search_knowledge_base' },
    executionType: 'internal',
    executionHandler: 'SearchKnowledgeCapability',
    isActive: true,
    isSystem: true,
    ...overrides,
  };
}

function makeCustomCapability(overrides = {}) {
  return {
    ...makeSystemCapability({ isSystem: false, slug: 'custom-cap', name: 'Custom Cap' }),
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeleteRequest(): NextRequest {
  return {
    method: 'DELETE',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/capabilities/${CAP_ID}`,
  } as unknown as NextRequest;
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'PATCH',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/capabilities/${CAP_ID}`,
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('System capability protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  describe('DELETE', () => {
    it('rejects deletion of system capabilities with 403', async () => {
      mockFindUnique.mockResolvedValue(makeSystemCapability());

      const response = await DELETE(makeDeleteRequest(), makeParams(CAP_ID));

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('System capabilities cannot be deleted');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('allows deletion of non-system capabilities', async () => {
      const cap = makeCustomCapability();
      mockFindUnique.mockResolvedValue(cap);
      mockUpdate.mockResolvedValue({ ...cap, isActive: false });

      const response = await DELETE(makeDeleteRequest(), makeParams(CAP_ID));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data.isActive).toBe(false);
    });
  });

  describe('PATCH — deactivation guard', () => {
    it('rejects isActive: false on system capabilities with 403', async () => {
      mockFindUnique.mockResolvedValue(makeSystemCapability());

      const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(CAP_ID));

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('System capabilities cannot be deactivated');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('allows isActive: false on non-system capabilities', async () => {
      const cap = makeCustomCapability();
      mockFindUnique.mockResolvedValue(cap);
      mockUpdate.mockResolvedValue({ ...cap, isActive: false });

      const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(CAP_ID));

      expect(response.status).toBe(200);
    });
  });
});
