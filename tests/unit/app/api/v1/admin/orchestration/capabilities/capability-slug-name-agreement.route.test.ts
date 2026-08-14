/**
 * Unit Test: PATCH keeps `functionDefinition.name` equal to `slug` (#509)
 *
 * Dispatch resolves the tool name a model emits AS the slug, so the two must
 * be the same string. `updateCapabilitySchema` can only decide the case where
 * a PATCH body carries BOTH halves; a body carrying one half has to be judged
 * against the stored row, which is what the route does.
 *
 * Test Coverage:
 * - PATCH moving only `functionDefinition.name` away from the stored slug → 400
 * - PATCH moving only `slug` away from the stored name → 400
 * - PATCH moving both together, in agreement → allowed
 * - PATCH of an unrelated field → not subject to the check
 * - PATCH against an unparseable stored definition → allowed (repair path)
 *
 * @see app/api/v1/admin/orchestration/capabilities/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/v1/admin/orchestration/capabilities/[id]/route';
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

/** A healthy stored row: slug and functionDefinition.name already agree. */
function makeStoredCapability(overrides = {}) {
  return {
    id: CAP_ID,
    name: 'Estimate Workflow Cost',
    slug: 'estimate_workflow_cost',
    description: 'Estimate the cost of a workflow run.',
    category: 'analysis',
    functionDefinition: {
      name: 'estimate_workflow_cost',
      description: 'Estimate cost',
      parameters: { type: 'object', properties: {} },
    },
    executionType: 'internal',
    executionHandler: 'EstimateCostCapability',
    isActive: true,
    isSystem: false,
    ...overrides,
  };
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

/**
 * Assert the 400 came from the agreement check and not from some other
 * validation that happens to reject the same body — the difference between a
 * test that pins the behaviour and one that merely pins the status code.
 */
async function expectRejectedForDivergence(response: Response): Promise<void> {
  const body: unknown = await response.json();
  expect(JSON.stringify(body)).toContain('must equal slug');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PATCH capability — slug / functionDefinition.name agreement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockUpdate.mockResolvedValue(makeStoredCapability());
  });

  it('rejects moving functionDefinition.name away from the stored slug', async () => {
    // The escalation shape from #509: the row keeps its innocuous slug while
    // the advertised name becomes a privileged capability's slug.
    mockFindUnique.mockResolvedValue(makeStoredCapability());

    const response = await PATCH(
      makePatchRequest({
        functionDefinition: { name: 'apply_audit_changes', description: 'x', parameters: {} },
      }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(400);
    await expectRejectedForDivergence(response);
    expect(mockUpdate).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the write must not land
  });

  it('rejects moving the slug away from the stored functionDefinition.name', async () => {
    // The same divergence reached from the other side — the schema cannot see
    // it, because only one half is in the body.
    //
    // The new slug is deliberately HYPHENATED. An underscore one would be
    // rejected by the pre-#509 slug rule as well, so the test would have gone
    // green whether or not the agreement check existed — it would pin the
    // status without pinning the cause.
    mockFindUnique.mockResolvedValue(makeStoredCapability());

    const response = await PATCH(
      makePatchRequest({ slug: 'apply-audit-changes' }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(400);
    await expectRejectedForDivergence(response);
    expect(mockUpdate).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the write must not land
  });

  it('allows renaming both halves together', async () => {
    mockFindUnique.mockResolvedValue(makeStoredCapability());

    const response = await PATCH(
      makePatchRequest({
        slug: 'estimate_run_cost',
        functionDefinition: { name: 'estimate_run_cost', description: 'x', parameters: {} },
      }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('does not interfere with a PATCH that touches neither half', async () => {
    mockFindUnique.mockResolvedValue(makeStoredCapability());

    const response = await PATCH(
      makePatchRequest({ description: 'A clearer description.' }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('cannot be walked around in two steps via a stripped definition', async () => {
    // The escape route the schema tightening closes. Step one PATCHes a
    // definition that AGREES with the slug but omits `description` and
    // `parameters`; because the column is replaced wholesale, that would have
    // left a row the read validator cannot parse. Step two then PATCHes the
    // slug alone, and with nothing to compare against the check was skipped —
    // divergence authored through the API despite the guard.
    //
    // Step one must now fail, so step two never gets its unparseable row.
    mockFindUnique.mockResolvedValue(makeStoredCapability());

    const response = await PATCH(
      makePatchRequest({ functionDefinition: { name: 'estimate_workflow_cost' } }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled(); // test-review:accept no_arg_called — the strip must not land
  });

  it('allows a slug change when the stored definition is unparseable', async () => {
    // Nothing to compare against, and the row is already inert —
    // `getCapabilityDefinitions` skips it. Blocking here would trap an admin
    // trying to repair the row.
    mockFindUnique.mockResolvedValue(makeStoredCapability({ functionDefinition: 'not-an-object' }));

    const response = await PATCH(
      makePatchRequest({ slug: 'estimate_run_cost' }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });
});

// ─── MCP tool-name pinning (#509) ────────────────────────────────────────────

describe('PATCH capability — pinning the MCP tool name before a rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    mockUpdate.mockResolvedValue(makeStoredCapability());
    mockMcpUpdateMany.mockResolvedValue({ count: 1 });
    mockMcpFindUnique.mockResolvedValue({ id: 'mcp-self' });
    mockMcpFindMany.mockResolvedValue([]);
  });

  /** A legacy row: hyphen slug, underscore function name — the pre-#509 default. */
  function makeDivergentCapability() {
    return makeStoredCapability({
      slug: 'search-web',
      functionDefinition: {
        name: 'search_web',
        description: 'Search the web.',
        parameters: { type: 'object', properties: {} },
      },
    });
  }

  it('pins the displaced name so an external MCP client keeps working', async () => {
    // `tools/list` advertises `customName ?? functionDefinition.name`, so
    // forcing the name to the slug renames the published tool. Anything
    // calling `search_web` would start getting "Unknown tool".
    mockFindUnique.mockResolvedValue(makeDivergentCapability());

    // What the form now sends: the name normalised onto the existing slug.
    const response = await PATCH(
      makePatchRequest({
        functionDefinition: { name: 'search-web', description: 'd', parameters: {} },
      }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(200);
    expect(mockMcpUpdateMany).toHaveBeenCalledWith({
      where: { capabilityId: CAP_ID, customName: null },
      data: { customName: 'search_web' },
    });
  });

  it('leaves an existing override alone', async () => {
    // The `customName: null` filter is what protects an operator's own choice
    // — pinning over it would silently retarget the published tool.
    mockFindUnique.mockResolvedValue(makeDivergentCapability());

    await PATCH(
      makePatchRequest({
        functionDefinition: { name: 'search-web', description: 'd', parameters: {} },
      }),
      makeParams(CAP_ID)
    );

    const where = mockMcpUpdateMany.mock.calls[0]?.[0]?.where as { customName: null };
    expect(where.customName).toBeNull();
  });

  it('does not touch MCP when the name is unchanged', async () => {
    // The overwhelmingly common save: nothing about the name moves, so nothing
    // about the published tool should either.
    mockFindUnique.mockResolvedValue(makeStoredCapability());

    await PATCH(makePatchRequest({ description: 'A clearer description.' }), makeParams(CAP_ID));

    expect(mockMcpUpdateMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — an unrelated edit must not rewrite MCP state
  });

  it('refuses to pin a name another exposed tool already advertises', async () => {
    // `customName` has no unique constraint and `callMcpTool` resolves with
    // `tools.find(t => t.name === toolName)` — first match wins. Pinning a
    // name already in use would make every call to it dispatch to whichever
    // row came back first, silently running the wrong capability. Breaking one
    // tool name loudly beats misrouting two.
    mockFindUnique.mockResolvedValue(makeDivergentCapability());
    mockMcpFindMany.mockResolvedValue([
      { id: 'mcp-other', customName: 'search_web', capability: { functionDefinition: {} } },
    ]);

    const response = await PATCH(
      makePatchRequest({
        functionDefinition: { name: 'search-web', description: 'd', parameters: {} },
      }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(200);
    expect(mockMcpUpdateMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — pinning here would misroute an existing tool
  });

  it('detects a clash against another tool with no override, by its real advertised name', async () => {
    // A null `customName` advertises `functionDefinition.name`, which for a
    // legacy row is NOT its slug — approximating with the slug would miss
    // precisely the rows this pin exists for.
    mockFindUnique.mockResolvedValue(makeDivergentCapability());
    mockMcpFindMany.mockResolvedValue([
      {
        id: 'mcp-other',
        customName: null,
        capability: {
          functionDefinition: {
            name: 'search_web',
            description: 'd',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    ]);

    await PATCH(
      makePatchRequest({
        functionDefinition: { name: 'search-web', description: 'd', parameters: {} },
      }),
      makeParams(CAP_ID)
    );

    expect(mockMcpUpdateMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — same collision, reached via the other tool's function name
  });

  it('says nothing about MCP for a capability that was never exposed', async () => {
    // Both warnings used to fire regardless of whether the capability had a
    // tool at all, announcing a moved tool name for an integration that does
    // not exist.
    mockFindUnique.mockResolvedValue(makeDivergentCapability());
    mockMcpFindUnique.mockResolvedValue(null);

    const response = await PATCH(
      makePatchRequest({
        functionDefinition: { name: 'search-web', description: 'd', parameters: {} },
      }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(200);
    expect(mockMcpUpdateMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — no exposed row, nothing to pin
  });

  it('looks for clashes against explicit names on ANY row, derived names only on live ones', async () => {
    // Asserting the QUERY, not the comparison. Which rows are considered is
    // decided in the `where` clause, so a mocked client returns whatever it is
    // told regardless — a test that fed it a disabled row and checked the
    // outcome would pass with or without the filter, proving nothing.
    //
    // The rule: an explicit `customName` claims the name even while disabled
    // (the row keeps it when re-enabled, and nothing enforces uniqueness at
    // the enable path), while a DERIVED name only exists while advertised.
    mockFindUnique.mockResolvedValue(makeDivergentCapability());

    await PATCH(
      makePatchRequest({
        functionDefinition: { name: 'search-web', description: 'd', parameters: {} },
      }),
      makeParams(CAP_ID)
    );

    const where = mockMcpFindMany.mock.calls[0]?.[0]?.where as {
      OR: Array<Record<string, unknown>>;
    };
    expect(where.OR).toEqual([
      { customName: { not: null } },
      { customName: null, isEnabled: true, capability: { isActive: true } },
    ]);
  });

  it('refuses to pin a name that could not legally live in customName', async () => {
    // `customName` is `^[a-z][a-z0-9_]*$`. Writing a hyphenated name would
    // satisfy this moment and then fail validation the next time an admin
    // edited the MCP row, on a field they had not touched — the same trap
    // #509 fixed in the capability form. The rename proceeds and is logged.
    mockFindUnique.mockResolvedValue(
      makeStoredCapability({
        slug: 'search_web',
        functionDefinition: {
          name: 'search-web',
          description: 'd',
          parameters: { type: 'object', properties: {} },
        },
      })
    );

    const response = await PATCH(
      makePatchRequest({
        functionDefinition: { name: 'search_web', description: 'd', parameters: {} },
      }),
      makeParams(CAP_ID)
    );

    expect(response.status).toBe(200);
    expect(mockMcpUpdateMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — an illegal customName must not be written
  });
});
