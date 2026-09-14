/**
 * Cross-surface test: the two `SetNull` models, on both policy branches.
 *
 * `AiDataset` and `AiExperiment` are the pair whose owner column is nulled by an
 * Art. 17 erasure rather than born null, and t-687 is the change that moved both
 * onto `session.unattributedReads` — the same precomputed answer executions and
 * conversations already read. Two things have to hold across that move, and each
 * is the other's control:
 *
 *  1. **The orphan arm follows the policy.** A fork that denies unattributed
 *     reads loses the de-attributed rows, and a default install does not. That
 *     branch was unreachable from these routes before t-685/t-686/t-687 —
 *     `mayReadUnattributed` was reached, but no test drove a narrowing policy
 *     through the dataset or experiment routes end to end.
 *  2. **The owner boundary does not move with it.** Another admin's row stays
 *     absent from every list and a 404 on every verb, *whichever* answer the
 *     policy gives. That is the t-677 / t-679 line, and it is the one a
 *     mechanical sweep is most likely to nudge: `'nobody owns this'` and
 *     `'someone else owns this'` are one character apart in a `where` fragment.
 *
 * Running both models and both branches in one file is the point. Four separate
 * files would each pass while the set of them disagreed, and the failure being
 * guarded against is precisely a divergence between surfaces — a list that hides
 * an orphan whose detail route still opens it, or vice versa.
 *
 * **The fakes filter.** `ownerScopedFindMany` / `ownerScopedFindFirst` /
 * `ownerScopedCount` apply the query's own owner clause the way the database
 * would, so a route that stopped narrowing turns these red. With
 * `mockResolvedValue` the route gets its rows back whatever it asked for, and
 * every assertion below would pass against an unscoped query.
 *
 * The real `withAdminAuth` runs: only `auth.api.getSession` is mocked, so the
 * guard resolves `session.unattributedReads` from the registered policy exactly
 * as a request does.
 *
 * @see tests/helpers/owner-scoped-prisma.ts — what the fakes understand
 * @see tests/unit/app/api/v1/admin/orchestration/executions/policy-narrowing.test.ts
 *      — the same shape for the two born-ownerless models
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
    aiExperiment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    aiDataset: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    aiDatasetCase: { findMany: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
    aiEvaluationCaseResult: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

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
import {
  ownerScopedFindFirst,
  ownerScopedFindMany,
  ownerScopedCount,
} from '@/tests/helpers/owner-scoped-prisma';

import { GET as listExperiments } from '@/app/api/v1/admin/orchestration/experiments/route';
import {
  GET as getExperiment,
  PATCH as patchExperiment,
  DELETE as deleteExperiment,
} from '@/app/api/v1/admin/orchestration/experiments/[id]/route';
import { POST as claimExperiment } from '@/app/api/v1/admin/orchestration/experiments/[id]/claim/route';
import { POST as runExperiment } from '@/app/api/v1/admin/orchestration/experiments/[id]/run/route';
import { GET as compareExperiment } from '@/app/api/v1/admin/orchestration/experiments/[id]/compare/route';
import { POST as verdictsExperiment } from '@/app/api/v1/admin/orchestration/experiments/[id]/verdicts/route';
import { GET as listDatasets } from '@/app/api/v1/admin/orchestration/evaluations/datasets/route';
import { GET as getDataset } from '@/app/api/v1/admin/orchestration/evaluations/datasets/[id]/route';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The id `mockAdminUser()` issues — the narrowed clause must key on exactly it. */
const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_ID = 'cmjbv4i3x00003wsloputgwuz';

/** CUIDs, because the dataset detail route validates the path param as one. */
const OWN_ID = 'cmjbv4i3x00003wsloputgw01';
const ORPHAN_ID = 'cmjbv4i3x00003wsloputgw02';
const FOREIGN_ID = 'cmjbv4i3x00003wsloputgw03';

function makeExperiment(id: string, createdBy: string | null) {
  return {
    id,
    name: `Experiment ${id}`,
    description: null,
    agentId: 'agent-1',
    status: 'draft',
    createdBy,
    datasetId: null,
    metricConfigs: null,
    pairwiseVerdict: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    agent: { id: 'agent-1', name: 'Agent', slug: 'agent' },
    dataset: null,
    variants: [],
    creator: null,
  };
}

function makeDataset(id: string, userId: string | null) {
  return {
    id,
    name: `Dataset ${id}`,
    description: null,
    tags: [],
    caseCount: 0,
    contentHash: 'hash',
    source: 'upload',
    userId,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

/** One of each of the three ownership cases, for both models. */
const EXPERIMENTS = [
  makeExperiment(OWN_ID, ADMIN_ID),
  makeExperiment(ORPHAN_ID, null),
  makeExperiment(FOREIGN_ID, OTHER_ID),
];
const DATASETS = [
  makeDataset(OWN_ID, ADMIN_ID),
  makeDataset(ORPHAN_ID, null),
  makeDataset(FOREIGN_ID, OTHER_ID),
];

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

// ─── Request helpers ──────────────────────────────────────────────────────────

function makeGetRequest(path: string): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration${path}`,
    nextUrl: { pathname: `/api/v1/admin/orchestration${path}` },
  } as unknown as NextRequest;
}

function makeBodyRequest(method: string, path: string, body: unknown): NextRequest {
  return {
    method,
    headers: new Headers({ 'content-type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration${path}`,
    nextUrl: { pathname: `/api/v1/admin/orchestration${path}` },
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function idsOf(response: Response): Promise<string[]> {
  const body = (await response.json()) as { data: { id: string }[] };
  return body.data.map((row) => row.id);
}

// ─── The matrix ───────────────────────────────────────────────────────────────

const BRANCHES = [
  { label: 'a default install (the policy permits unattributed reads)', narrowed: false },
  { label: 'a fork whose policy denies unattributed reads', narrowed: true },
];

describe.each(BRANCHES)('$label', ({ narrowed }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    vi.mocked(prisma.aiExperiment.findMany).mockImplementation(
      ownerScopedFindMany(EXPERIMENTS) as never
    );
    vi.mocked(prisma.aiExperiment.count).mockImplementation(ownerScopedCount(EXPERIMENTS) as never);
    vi.mocked(prisma.aiExperiment.findFirst).mockImplementation(
      ownerScopedFindFirst(EXPERIMENTS) as never
    );
    vi.mocked(prisma.aiExperiment.update).mockResolvedValue(makeExperiment(OWN_ID, ADMIN_ID));
    vi.mocked(prisma.aiExperiment.delete).mockResolvedValue(makeExperiment(OWN_ID, ADMIN_ID));
    vi.mocked(prisma.aiExperiment.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.aiExperiment.findUniqueOrThrow).mockResolvedValue(
      makeExperiment(ORPHAN_ID, ADMIN_ID)
    );

    vi.mocked(prisma.aiDataset.findMany).mockImplementation(ownerScopedFindMany(DATASETS) as never);
    vi.mocked(prisma.aiDataset.count).mockImplementation(ownerScopedCount(DATASETS) as never);
    vi.mocked(prisma.aiDataset.findFirst).mockImplementation(
      ownerScopedFindFirst(DATASETS) as never
    );
    vi.mocked(prisma.aiDatasetCase.findMany).mockResolvedValue([] as never);

    if (narrowed) registerNoUnattributedReads();
  });

  afterEach(() => {
    __resetAuthorizationPolicyForTests();
  });

  // ── 1. The orphan arm follows the policy ───────────────────────────────────

  it(`${narrowed ? 'hides' : 'shows'} the de-attributed experiment in the list`, async () => {
    const response = await listExperiments(makeGetRequest('/experiments'));

    expect(response.status).toBe(200);
    expect(await idsOf(response)).toEqual(narrowed ? [OWN_ID] : [OWN_ID, ORPHAN_ID]);
  });

  it(`${narrowed ? 'hides' : 'shows'} the de-attributed dataset in the list`, async () => {
    const response = await listDatasets(makeGetRequest('/evaluations/datasets'));

    expect(response.status).toBe(200);
    expect(await idsOf(response)).toEqual(narrowed ? [OWN_ID] : [OWN_ID, ORPHAN_ID]);
  });

  it('counts the page over the same clause it listed', async () => {
    // A total computed from a wider clause reports pages the list cannot fill,
    // and leaks the existence of the rows it refused to return.
    await listExperiments(makeGetRequest('/experiments'));
    await listDatasets(makeGetRequest('/evaluations/datasets'));

    const expected = narrowed ? 1 : 2;
    expect(await vi.mocked(prisma.aiExperiment.count).mock.results[0]?.value).toBe(expected);
    expect(await vi.mocked(prisma.aiDataset.count).mock.results[0]?.value).toBe(expected);
  });

  it(`${narrowed ? '404s' : 'opens'} the de-attributed experiment's detail route`, async () => {
    const response = await getExperiment(
      makeGetRequest(`/experiments/${ORPHAN_ID}`),
      ctx(ORPHAN_ID)
    );

    expect(response.status).toBe(narrowed ? 404 : 200);
  });

  it(`${narrowed ? '404s' : 'opens'} the de-attributed dataset's detail route`, async () => {
    const response = await getDataset(
      makeGetRequest(`/evaluations/datasets/${ORPHAN_ID}`),
      ctx(ORPHAN_ID)
    );

    expect(response.status).toBe(narrowed ? 404 : 200);
  });

  it(`${narrowed ? 'refuses' : 'allows'} claiming the de-attributed experiment`, async () => {
    // The route that exists to make an orphan normal again. Under a narrowing
    // policy the row is not visible to this caller, so it is not theirs to
    // adopt — and the 404 is the same one a foreign row gets, so claiming
    // cannot be used to probe for rows the list refuses to show.
    const response = await claimExperiment(
      makeBodyRequest('POST', `/experiments/${ORPHAN_ID}/claim`, {}),
      ctx(ORPHAN_ID)
    );

    expect(response.status).toBe(narrowed ? 404 : 200);
  });

  // ── 2. The owner boundary does not move with it ────────────────────────────

  it("keeps another admin's experiment out of the list", async () => {
    const response = await listExperiments(makeGetRequest('/experiments'));

    expect(await idsOf(response)).not.toContain(FOREIGN_ID);
  });

  it("keeps another admin's dataset out of the list", async () => {
    const response = await listDatasets(makeGetRequest('/evaluations/datasets'));

    expect(await idsOf(response)).not.toContain(FOREIGN_ID);
  });

  it("404s another admin's experiment on every verb, and writes nothing", async () => {
    // Every handler in the family, not a sample: the ones that bail at the
    // first `findFirst` cost nothing to include, and "every verb" is the claim
    // the done-when makes. `run` and `verdicts` never reach their expensive
    // paths here — the 404 is thrown before the transaction and before the
    // judge agent is looked up.
    const responses = await Promise.all([
      getExperiment(makeGetRequest(`/experiments/${FOREIGN_ID}`), ctx(FOREIGN_ID)),
      patchExperiment(
        makeBodyRequest('PATCH', `/experiments/${FOREIGN_ID}`, { name: 'Hijacked' }),
        ctx(FOREIGN_ID)
      ),
      deleteExperiment(
        makeBodyRequest('DELETE', `/experiments/${FOREIGN_ID}`, {}),
        ctx(FOREIGN_ID)
      ),
      claimExperiment(
        makeBodyRequest('POST', `/experiments/${FOREIGN_ID}/claim`, {}),
        ctx(FOREIGN_ID)
      ),
      runExperiment(makeBodyRequest('POST', `/experiments/${FOREIGN_ID}/run`, {}), ctx(FOREIGN_ID)),
      compareExperiment(makeGetRequest(`/experiments/${FOREIGN_ID}/compare`), ctx(FOREIGN_ID)),
      verdictsExperiment(
        makeBodyRequest('POST', `/experiments/${FOREIGN_ID}/verdicts`, {
          variantAId: 'v1',
          variantBId: 'v2',
          judgeAgentSlug: 'judge',
        }),
        ctx(FOREIGN_ID)
      ),
    ]);

    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(vi.mocked(prisma.aiExperiment.update)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.aiExperiment.updateMany)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.aiExperiment.delete)).not.toHaveBeenCalled();
  });

  it("404s another admin's dataset on the detail route", async () => {
    const response = await getDataset(
      makeGetRequest(`/evaluations/datasets/${FOREIGN_ID}`),
      ctx(FOREIGN_ID)
    );

    expect(response.status).toBe(404);
  });

  // ── 3. The control: the 404s above are the filter, not a dead fake ─────────

  it("still opens the caller's own rows on both models", async () => {
    // Same fakes, same fixtures, only the owner differs. Without this, a fake
    // that returned null unconditionally would make every 404 above green while
    // proving nothing at all.
    const experiment = await getExperiment(makeGetRequest(`/experiments/${OWN_ID}`), ctx(OWN_ID));
    const dataset = await getDataset(
      makeGetRequest(`/evaluations/datasets/${OWN_ID}`),
      ctx(OWN_ID)
    );

    expect(experiment.status).toBe(200);
    expect(dataset.status).toBe(200);
  });
});
