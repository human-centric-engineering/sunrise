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

const mockMcpUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
const mockMcpFindMany = vi.fn().mockResolvedValue([]);
const mockMcpFindUnique = vi.fn().mockResolvedValue({ id: 'mcp-self' });

vi.mock('@/lib/orchestration/mcp', () => ({
  clearMcpToolCache: vi.fn(),
  broadcastMcpToolsChanged: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    mcpExposedTool: {
      updateMany: (...args: unknown[]) => mockMcpUpdateMany(...args),
      findMany: (...args: unknown[]) => mockMcpFindMany(...args),
      findUnique: (...args: unknown[]) => mockMcpFindUnique(...args),
    },
    // PATCH pins the MCP tool name and updates the capability in one
    // transaction (#509); run the callback against the same doubles.
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        aiCapability: { update: (...args: unknown[]) => mockUpdate(...args) },
        mcpExposedTool: {
          updateMany: (...args: unknown[]) => mockMcpUpdateMany(...args),
          findMany: (...args: unknown[]) => mockMcpFindMany(...args),
          findUnique: (...args: unknown[]) => mockMcpFindUnique(...args),
        },
      }),
  },
}));

vi.mock('@/lib/orchestration/capabilities', () => ({
  capabilityDispatcher: { clearCache: vi.fn() },
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

    it.each([
      [
        'functionDefinition',
        { functionDefinition: { name: 'search_knowledge_base', description: 'd', parameters: {} } },
      ],
      ['executionType', { executionType: 'api' as const }],
      ['executionHandler', { executionHandler: 'SomethingElse' }],
    ])('refuses to edit %s on a system capability', async (field, body) => {
      // Since #545 the seed re-applies these on every deploy whose seed-file
      // hash changed. Accepting the write would log a `capability.update`
      // audit entry, show the operator success, then silently revert it later
      // with no audit entry at all. A 403 now beats a disappearing edit.
      //
      // The payloads are deliberately VALID — `functionDefinition.name` must
      // equal the slug, `executionType` is an enum — so the request reaches
      // the ownership guard rather than stopping at a 400, which would have
      // made this test pass without ever exercising it.
      mockFindUnique.mockResolvedValue(makeSystemCapability());

      const response = await PATCH(makePatchRequest(body), makeParams(CAP_ID));

      expect(response.status).toBe(403);
      expect((await response.json()).error.message).toContain(field);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('still allows the operator-owned fields on a system capability', async () => {
      // The other half of the ownership split: the seed leaves these alone, so
      // the API must not lock them. Over-correcting here would make built-in
      // capabilities unrenameable and untunable.
      const cap = makeSystemCapability();
      mockFindUnique.mockResolvedValue(cap);
      mockUpdate.mockResolvedValue({ ...cap, name: 'Renamed' });

      const response = await PATCH(
        makePatchRequest({ name: 'Renamed', description: 'ours', rateLimit: 5 }),
        makeParams(CAP_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
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
