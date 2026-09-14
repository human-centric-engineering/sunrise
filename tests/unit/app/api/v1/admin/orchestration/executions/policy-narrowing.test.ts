/**
 * Cross-surface test: a fork narrows who may see runs nobody started.
 *
 * `lib/orchestration/access/execution-access.ts` used to hard-code the answer —
 * every admin saw every schedule- and inbound-triggered run. That is right on a
 * single-tenant install and wrong under a customer tier, and no policy could
 * reach it. This file is the proof that it now can (t-685), and that the four
 * surfaces move **together**.
 *
 * Together is the point, and it is why these live in one file rather than one
 * case each in four. A list that hides a scheduled run while its detail route
 * still opens it, or a sidebar badge counting rows the list refuses to show, is
 * the list/detail divergence `checkAuthorizationParity` exists to catch — and
 * four separate cases would each pass while the set of them disagreed.
 *
 * The real `withAdminAuth` runs here: only `auth.api.getSession` is mocked, so
 * the guard resolves `session.unattributedReads` from the registered policy the
 * way a request does. Asserting against the `where` clauses the routes hand
 * Prisma, rather than against rows, is deliberate — these are unit tests with a
 * mocked client, and the boundary being asserted is the query, which is where a
 * regression would actually appear.
 *
 * The default-install direction is covered in each route's own test file and is
 * not repeated here.
 *
 * @see lib/auth/orphan-reads.ts — where the answer comes from
 * @see tests/unit/lib/orchestration/access/execution-access.test.ts — the helper
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mocks (must precede any import that loads the mocked modules) ────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowExecution: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    aiWorkflowRunningStep: { findMany: vi.fn() },
    aiAgent: { findMany: vi.fn() },
    aiConversation: { count: vi.fn() },
    aiCostLog: { count: vi.fn(), findMany: vi.fn() },
    aiMessage: { groupBy: vi.fn() },
  },
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

// ─── Imports (after vi.mock calls) ───────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';
import { GET as listExecutions } from '@/app/api/v1/admin/orchestration/executions/route';
import { GET as executionCounts } from '@/app/api/v1/admin/orchestration/executions/counts/route';
import { GET as executionDetail } from '@/app/api/v1/admin/orchestration/executions/[id]/route';
import { GET as dashboardStats } from '@/app/api/v1/admin/orchestration/observability/dashboard-stats/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The id `mockAdminUser()` issues — the narrowed clause must key on exactly it. */
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const EXEC_ID = 'cmjbv4i3x00003wsloputgwu9';

/** What a fork with tenants registers: own rows yes, nobody's rows no. */
function registerNoUnattributedReads(): void {
  registerAuthorizationPolicy({
    ...DEFAULT_AUTHORIZATION_POLICY,
    canRead: (viewer, target, scope) =>
      target.kind === 'unattributed'
        ? Promise.resolve(false)
        : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
  });
}

function makeRequest(path: string): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration${path}`,
    nextUrl: { pathname: `/api/v1/admin/orchestration${path}` },
  } as unknown as NextRequest;
}

/** The first `AND` arm of a where clause — where the visibility boundary sits. */
function boundaryOf(where: unknown): unknown {
  return (where as { AND: unknown[] }).AND[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  vi.mocked(prisma.aiWorkflowExecution.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.aiWorkflowExecution.count).mockResolvedValue(0);
  vi.mocked(prisma.aiWorkflowExecution.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.aiWorkflowRunningStep.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
  vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.aiCostLog.count).mockResolvedValue(0);
  vi.mocked(prisma.aiCostLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([] as never);
  registerNoUnattributedReads();
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

// ─── The four read surfaces ───────────────────────────────────────────────────

describe('a policy that denies unattributed reads', () => {
  it('drops system-owned runs from the executions list', async () => {
    const response = await listExecutions(makeRequest('/executions'));
    expect(response.status).toBe(200);

    const where = vi.mocked(prisma.aiWorkflowExecution.findMany).mock.calls[0]?.[0]?.where;
    // No `OR` arm admitting `userId: null` — the narrowed fragment is the bare
    // own-rows clause, and it is still the first `AND` arm so the query-param
    // filters beside it cannot widen it back.
    expect(boundaryOf(where)).toEqual({ userId: ADMIN_ID });
    // The paginated total must be counted over the same clause. A count that
    // still admitted system runs would report pages the list cannot fill.
    const countWhere = vi.mocked(prisma.aiWorkflowExecution.count).mock.calls[0]?.[0]?.where;
    expect(countWhere).toEqual(where);
  });

  it('drops them from the sidebar status counts', async () => {
    const response = await executionCounts(makeRequest('/executions/counts?statuses=running'));
    expect(response.status).toBe(200);

    const where = vi.mocked(prisma.aiWorkflowExecution.groupBy).mock.calls[0]?.[0]?.where;
    expect(boundaryOf(where)).toEqual({ userId: ADMIN_ID });
  });

  it('drops them from the observability dashboard counts', async () => {
    const response = await dashboardStats(makeRequest('/observability/dashboard-stats'));
    expect(response.status).toBe(200);

    // All three execution reads on this page — 24h total, 24h failures, and
    // the recent-failure list — carry the same boundary. One of them left
    // behind would show an error rate computed over rows the operator cannot
    // open.
    for (const call of vi.mocked(prisma.aiWorkflowExecution.count).mock.calls) {
      expect(boundaryOf(call[0]?.where)).toEqual({ userId: ADMIN_ID });
    }
    const recentWhere = vi.mocked(prisma.aiWorkflowExecution.findMany).mock.calls[0]?.[0]?.where;
    expect(boundaryOf(recentWhere)).toEqual({ userId: ADMIN_ID });
  });

  it('404s the detail route for a system-owned run', async () => {
    // The detail route fetches by id and then asks, so the list's narrowed
    // clause does nothing for it. Before t-685 this row opened.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: EXEC_ID,
      userId: null,
      executionTrace: [],
      version: null,
      workflow: { id: 'wf-1', name: 'Nightly', slug: 'nightly' },
    } as never);

    const response = await executionDetail(makeRequest(`/executions/${EXEC_ID}`), {
      params: Promise.resolve({ id: EXEC_ID }),
    });

    // 404, not 403: confirming the row exists is an id-enumeration vector.
    expect(response.status).toBe(404);
  });

  it('still opens the caller’s own run on the detail route', async () => {
    // The control. Without it, a detail route broken in some unrelated way
    // would pass the case above for the wrong reason.
    vi.mocked(prisma.aiWorkflowExecution.findUnique).mockResolvedValue({
      id: EXEC_ID,
      userId: ADMIN_ID,
      executionTrace: [],
      version: null,
      workflow: { id: 'wf-1', name: 'Nightly', slug: 'nightly' },
      status: 'completed',
    } as never);

    const response = await executionDetail(makeRequest(`/executions/${EXEC_ID}`), {
      params: Promise.resolve({ id: EXEC_ID }),
    });

    expect(response.status).toBe(200);
  });
});
