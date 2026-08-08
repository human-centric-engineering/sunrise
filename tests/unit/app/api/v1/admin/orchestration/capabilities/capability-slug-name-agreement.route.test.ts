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
