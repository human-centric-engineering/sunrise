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

// The route imports `changedSeedOwnedFields` from this barrel too. It is a
// pure comparison over values the test already controls, so it is wired to the
// REAL implementation — stubbing it would make the system-capability guard
// assert against the stub rather than against the rule (#598).
vi.mock('@/lib/orchestration/capabilities', async () => ({
  capabilityDispatcher: { clearCache: vi.fn() },
  changedSeedOwnedFields: (await import('@/lib/orchestration/capabilities/seed-owned'))
    .changedSeedOwnedFields,
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

/**
 * `functionDefinition` keys are in the order Postgres canonicalises `jsonb` to
 * — shortest key first, then bytewise — NOT the order the route's Zod schema
 * rebuilds a parsed body in. The seed-owned guard has to see through that
 * difference, and a fixture that happened to match the payload's key order
 * would let a `JSON.stringify` comparison pass this suite (#598).
 */
const STORED_FUNCTION_DEFINITION = {
  name: 'search_knowledge_base',
  parameters: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' } },
  },
  description: 'Semantic search over the knowledge base.',
};

/** The same definition as the capability form echoes it back — Zod's order. */
const ECHOED_FUNCTION_DEFINITION = {
  name: 'search_knowledge_base',
  description: 'Semantic search over the knowledge base.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

function makeSystemCapability(overrides = {}) {
  return {
    id: CAP_ID,
    name: 'Search Knowledge Base',
    slug: 'search_knowledge_base',
    description: 'Semantic search over the knowledge base.',
    category: 'knowledge',
    functionDefinition: STORED_FUNCTION_DEFINITION,
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

  // ── Seed-owned fields (#598) ───────────────────────────────────────────────
  // The seeds re-apply `functionDefinition`, `executionType` and
  // `executionHandler` on every deploy whose seed-file hash changes, and match
  // on `slug`. A write to any of them on a system row is either reverted with
  // no audit entry or (for `slug`) leaves a duplicate row, so it is refused.
  describe('PATCH — seed-owned fields on a system capability', () => {
    /** What the capability form actually sends: the entire form, every save. */
    function fullFormBody(overrides: Record<string, unknown> = {}) {
      return {
        name: 'Search Knowledge Base',
        description: 'Semantic search over the knowledge base.',
        category: 'knowledge',
        slug: 'search_knowledge_base',
        functionDefinition: ECHOED_FUNCTION_DEFINITION,
        executionType: 'internal',
        executionHandler: 'SearchKnowledgeCapability',
        ...overrides,
      };
    }

    it('allows a description-only edit even though the form resubmits every field', async () => {
      // Trap 1: a guard keyed on the field being PRESENT would 403 here,
      // naming three fields the admin never touched — and would make name,
      // description, category, rate limit and every safety setting
      // uneditable on every built-in.
      const cap = makeSystemCapability();
      mockFindUnique.mockResolvedValue(cap);
      mockUpdate.mockResolvedValue({ ...cap, description: 'Updated copy.' });

      const response = await PATCH(
        makePatchRequest(fullFormBody({ description: 'Updated copy.' })),
        makeParams(CAP_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
    });

    it('allows a save where functionDefinition differs only in key order', async () => {
      // Trap 2: `functionDefinition` is jsonb. Postgres canonicalises its key
      // order on write and Zod rebuilds the parsed body in schema order, so a
      // `JSON.stringify` comparison calls a byte-identical value "changed".
      // Assert the naive comparison would have fired, so this cannot pass for
      // the wrong reason.
      expect(JSON.stringify(ECHOED_FUNCTION_DEFINITION)).not.toBe(
        JSON.stringify(STORED_FUNCTION_DEFINITION)
      );

      const cap = makeSystemCapability();
      mockFindUnique.mockResolvedValue(cap);
      mockUpdate.mockResolvedValue(cap);

      const response = await PATCH(
        makePatchRequest({ functionDefinition: ECHOED_FUNCTION_DEFINITION }),
        makeParams(CAP_ID)
      );

      expect(response.status).toBe(200);
    });

    it('rejects a changed functionDefinition with 403 naming the field', async () => {
      mockFindUnique.mockResolvedValue(makeSystemCapability());

      const response = await PATCH(
        makePatchRequest(
          fullFormBody({
            functionDefinition: {
              ...ECHOED_FUNCTION_DEFINITION,
              parameters: { type: 'object', properties: { query: { type: 'number' } } },
            },
          })
        ),
        makeParams(CAP_ID)
      );

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('functionDefinition');
      expect(json.error.message).toContain('seeded from code');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects a changed executionHandler with 403', async () => {
      mockFindUnique.mockResolvedValue(makeSystemCapability());

      const response = await PATCH(
        makePatchRequest(fullFormBody({ executionHandler: 'SomeOtherCapability' })),
        makeParams(CAP_ID)
      );

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('executionHandler');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects a slug rename with 403 rather than the slug/name agreement 400', async () => {
      // A rename has to move `functionDefinition.name` with it or the #509
      // agreement check rejects it first — with a 400 about a field the
      // operator did not touch. The seed-owned guard runs before that check so
      // the answer names the real reason.
      mockFindUnique.mockResolvedValue(makeSystemCapability());

      const response = await PATCH(
        makePatchRequest(
          fullFormBody({
            slug: 'search_kb',
            functionDefinition: { ...ECHOED_FUNCTION_DEFINITION, name: 'search_kb' },
          })
        ),
        makeParams(CAP_ID)
      );

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('slug');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('reports every changed seed-owned field at once, not just the first', async () => {
      mockFindUnique.mockResolvedValue(makeSystemCapability());

      const response = await PATCH(
        makePatchRequest(
          fullFormBody({ executionType: 'api', executionHandler: 'https://example.com/run' })
        ),
        makeParams(CAP_ID)
      );

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('executionType');
      expect(json.error.message).toContain('executionHandler');
    });

    it('leaves the same change unguarded on a non-system capability', async () => {
      // The guard is scoped to `isSystem`. A custom capability's execution
      // config is nobody's but the operator's.
      const cap = makeCustomCapability({
        slug: 'custom-cap',
        functionDefinition: { ...STORED_FUNCTION_DEFINITION, name: 'custom-cap' },
      });
      mockFindUnique.mockResolvedValue(cap);
      mockUpdate.mockResolvedValue(cap);

      const response = await PATCH(
        makePatchRequest({ executionHandler: 'SomeOtherCapability' }),
        makeParams(CAP_ID)
      );

      expect(response.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });
});
