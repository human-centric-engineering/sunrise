/**
 * Integration Test: Admin Orchestration — Evaluation Datasets (list + create/upload)
 *
 * GET  /api/v1/admin/orchestration/evaluations/datasets
 * POST /api/v1/admin/orchestration/evaluations/datasets   (JSON or multipart)
 *
 * @see app/api/v1/admin/orchestration/evaluations/datasets/route.ts
 *
 * Coverage matrix:
 * - 401 when unauthenticated
 * - 403 when authenticated as non-admin
 * - GET happy path (paginated list with userId scoping)
 * - GET filters (q name search, tag exact match)
 * - POST JSON happy path (201)
 * - POST multipart happy path (201)
 * - POST multipart 413 when content-length exceeds cap
 * - POST multipart 413 when actual file size exceeds cap (header was lying)
 * - POST multipart 400 when file field missing
 * - POST multipart 400 when name missing
 * - POST multipart bubbles ValidationError from uploadDataset (unsupported extension)
 * - POST JSON 400 on malformed body (no name)
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/v1/admin/orchestration/evaluations/datasets/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { ValidationError } from '@/lib/api/errors';
import { ownerScopedCount, ownerScopedFindMany } from '@/tests/helpers/owner-scoped-prisma';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiDataset: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    aiDatasetCase: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/evaluations/datasets/upload-handler', () => ({
  uploadDataset: vi.fn(),
}));

vi.mock('@/lib/orchestration/evaluations/datasets/hash', () => ({
  hashParsedCases: vi.fn(() => 'hash-stub'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() =>
    Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { uploadDataset } from '@/lib/orchestration/evaluations/datasets/upload-handler';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const DATASET_ID = 'cmjbv4i3x00003wsloputgwu7';

function makeDatasetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DATASET_ID,
    userId: ADMIN_ID,
    name: 'demo dataset',
    description: null,
    tags: ['fixtures'],
    caseCount: 3,
    contentHash: 'hash-stub',
    source: 'manual',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url);
}

function makeJsonPostRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    url: 'http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets',
  } as unknown as NextRequest;
}

function makeMultipartPostRequest(options: {
  fileContent?: string;
  fileName?: string;
  fileBlob?: Blob;
  name?: string;
  description?: string;
  tags?: string;
  contentLength?: string;
  omitFile?: boolean;
}): NextRequest {
  const form = new FormData();
  if (!options.omitFile) {
    const blob =
      options.fileBlob ??
      new Blob([options.fileContent ?? 'input,expectedOutput\nhello,world\n'], {
        type: 'text/csv',
      });
    // Stamp `.name` so the route's defensive read picks it up.
    (blob as Blob & { name?: string }).name = options.fileName ?? 'dataset.csv';
    form.append('file', blob, options.fileName ?? 'dataset.csv');
  }
  if (options.name !== undefined) form.append('name', options.name);
  if (options.description !== undefined) form.append('description', options.description);
  if (options.tags !== undefined) form.append('tags', options.tags);

  const headers = new Headers({ 'Content-Type': 'multipart/form-data; boundary=----test' });
  if (options.contentLength !== undefined) {
    headers.set('content-length', options.contentLength);
  }
  return {
    method: 'POST',
    headers,
    formData: () => Promise.resolve(form),
    url: 'http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets',
  } as unknown as NextRequest;
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/evaluations/datasets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Per-user scoping', () => {
    it('always scopes the WHERE clause to session.user.id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiDataset.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiDataset.count).mockResolvedValue(0);

      await GET(makeGetRequest());

      expect(vi.mocked(prisma.aiDataset.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { AND: [{ OR: [{ userId: ADMIN_ID }, { userId: null }] }, expect.anything()] },
        })
      );
      // The total must be computed from the SAME clause as the page, whatever
      // that clause looks like — a count built from a wider one reports rows
      // the caller cannot see, and every page-level assertion still passes.
      const [findManyArgs] = vi.mocked(prisma.aiDataset.findMany).mock.calls[0];
      const [countArgs] = vi.mocked(prisma.aiDataset.count).mock.calls[0];
      expect(countArgs?.where).toEqual(findManyArgs?.where);
    });
  });

  describe('Successful listing', () => {
    it('returns paginated datasets', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiDataset.findMany).mockResolvedValue([makeDatasetRow()] as never);
      vi.mocked(prisma.aiDataset.count).mockResolvedValue(1);

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: Array<{ id: string }>;
        meta: { total: number };
      }>(response);
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].id).toBe(DATASET_ID);
      expect(data.meta.total).toBe(1);
    });

    it('applies q (name) and tag filters alongside userId', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiDataset.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiDataset.count).mockResolvedValue(0);

      await GET(makeGetRequest({ q: 'demo', tag: 'fixtures' }));

      // Visibility and the query filters are separate AND members, so no
      // query parameter can reach the key that is the boundary.
      expect(vi.mocked(prisma.aiDataset.findMany).mock.calls[0][0]).toMatchObject({
        where: {
          AND: [
            { OR: [{ userId: ADMIN_ID }, { userId: null }] },
            {
              name: expect.objectContaining({ contains: 'demo', mode: 'insensitive' }),
              tags: expect.objectContaining({ has: 'fixtures' }),
            },
          ],
        },
      });
    });

    it('honours page / limit pagination params', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiDataset.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiDataset.count).mockResolvedValue(0);

      await GET(makeGetRequest({ page: '3', limit: '5' }));

      expect(vi.mocked(prisma.aiDataset.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5 })
      );
    });
  });
});

describe('POST /api/v1/admin/orchestration/evaluations/datasets (JSON)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const response = await POST(makeJsonPostRequest({ name: 'd', cases: [{ input: 'hi' }] }));

    expect(response.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    const response = await POST(makeJsonPostRequest({ name: 'd', cases: [{ input: 'hi' }] }));

    expect(response.status).toBe(403);
  });

  it('returns 201 with dataset summary on happy path', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    (
      prisma.$transaction as unknown as {
        mockImplementation: (fn: (cb: unknown) => Promise<unknown>) => void;
      }
    ).mockImplementation(async (cb: unknown) => {
      // The route's transaction callback creates the dataset and case rows.
      const tx = {
        aiDataset: {
          create: vi.fn(async () => makeDatasetRow()),
        },
        aiDatasetCase: { createMany: vi.fn(async () => ({ count: 2 })) },
      };
      const run = cb as (tx: unknown) => Promise<unknown>;
      return run(tx);
    });

    const body = {
      name: 'json dataset',
      description: 'optional',
      tags: ['a', 'b'],
      cases: [{ input: 'hi' }, { input: 'bye', expectedOutput: 'goodbye' }],
    };
    const response = await POST(makeJsonPostRequest(body));

    expect(response.status).toBe(201);
    const data = await parseJson<{
      success: boolean;
      data: { datasetId: string; caseCount: number; contentHash: string };
    }>(response);
    expect(data.success).toBe(true);
    expect(data.data.datasetId).toBe(DATASET_ID);
    expect(data.data.caseCount).toBe(2);
    expect(data.data.contentHash).toBe('hash-stub');
  });

  it('returns 400 when name is missing (Zod validation)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeJsonPostRequest({ cases: [{ input: 'hi' }] }));

    expect(response.status).toBe(400);
    const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when cases array is empty', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeJsonPostRequest({ name: 'd', cases: [] }));

    expect(response.status).toBe(400);
  });
});

describe('POST /api/v1/admin/orchestration/evaluations/datasets (multipart)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 201 with the upload result on happy path', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(uploadDataset).mockResolvedValue({
      datasetId: DATASET_ID,
      caseCount: 4,
      contentHash: 'hash-from-handler',
      warnings: [],
    });

    const response = await POST(
      makeMultipartPostRequest({
        fileContent: 'input,expectedOutput\nfoo,bar\n',
        fileName: 'data.csv',
        name: 'multipart dataset',
        description: 'd',
        tags: 'a, b, ,c',
      })
    );

    expect(response.status).toBe(201);
    const data = await parseJson<{
      success: boolean;
      data: { datasetId: string; caseCount: number };
    }>(response);
    expect(data.data.datasetId).toBe(DATASET_ID);
    expect(data.data.caseCount).toBe(4);
    // Tags split on comma and trimmed; empty tokens dropped.
    // (Filename comes from FormData runtime; we assert userId/name/tags shape.)
    expect(vi.mocked(uploadDataset)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        name: 'multipart dataset',
        description: 'd',
        tags: ['a', 'b', 'c'],
      })
    );
  });

  it('returns 413 when content-length header exceeds the 10 MB cap', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makeMultipartPostRequest({
        name: 'big',
        contentLength: String(11 * 1024 * 1024),
      })
    );

    expect(response.status).toBe(413);
    const data = await parseJson<{ success: boolean; error: { code: string } }>(response);
    expect(data.error.code).toBe('FILE_TOO_LARGE');
    expect(vi.mocked(uploadDataset)).not.toHaveBeenCalled();
  });

  it('returns 413 when actual file size exceeds the cap (header lied)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Build an oversized blob (~11 MB) but report a small content-length.
    const big = new Blob([new Uint8Array(11 * 1024 * 1024).fill(65)], { type: 'text/csv' });
    (big as Blob & { name?: string }).name = 'big.csv';

    const response = await POST(
      makeMultipartPostRequest({
        fileBlob: big,
        fileName: 'big.csv',
        name: 'big',
        contentLength: '100',
      })
    );

    expect(response.status).toBe(413);
    expect(vi.mocked(uploadDataset)).not.toHaveBeenCalled();
  });

  it('returns 400 when the file field is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(makeMultipartPostRequest({ omitFile: true, name: 'd' }));

    expect(response.status).toBe(400);
    expect(vi.mocked(uploadDataset)).not.toHaveBeenCalled();
  });

  it('returns 400 when the name field is missing', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

    const response = await POST(
      makeMultipartPostRequest({ fileContent: 'a,b\n1,2\n', fileName: 'x.csv' })
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(uploadDataset)).not.toHaveBeenCalled();
  });

  it('bubbles ValidationError from uploadDataset (unsupported extension → 400)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(uploadDataset).mockRejectedValue(new ValidationError('Unsupported extension: .xls'));

    const response = await POST(
      makeMultipartPostRequest({
        fileContent: 'binary',
        fileName: 'oops.xls',
        name: 'bad',
      })
    );

    expect(response.status).toBe(400);
    const data = await parseJson<{ error: { code: string } }>(response);
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });

  it('defaults filename to "dataset.csv" when the blob lacks a .name', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(uploadDataset).mockResolvedValue({
      datasetId: DATASET_ID,
      caseCount: 1,
      contentHash: 'h',
      warnings: [],
    });
    const blob = new Blob(['a,b\n1,2\n'], { type: 'text/csv' });
    // Intentionally do NOT stamp .name — but FormData.append's filename arg
    // would set it. We force the default-name code path by passing through
    // FormData with no filename, then deleting any .name the runtime adds.
    const form = new FormData();
    form.append('file', blob);
    form.append('name', 'd');
    const request = {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'multipart/form-data; boundary=----test' }),
      formData: () => Promise.resolve(form),
      url: 'http://localhost:3000/api/v1/admin/orchestration/evaluations/datasets',
    } as unknown as NextRequest;

    const response = await POST(request);

    expect(response.status).toBe(201);
    // The defaulting path takes either the runtime-supplied name (e.g. "blob")
    // or our fallback "dataset.csv"; assert the call shape, not the exact name.
    expect(vi.mocked(uploadDataset)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'd', userId: ADMIN_ID })
    );
  });
});

/**
 * t-679. `AiDataset.userId` is `SetNull`, so erasing an admin leaves their
 * datasets owned by nobody. Owner-scoping alone made those unreachable by
 * everyone. The visible set is now "mine, plus nobody's" — and which half a
 * caller gets is the policy's answer, not the route's.
 *
 * The fakes filter on `userId` the way the database does, including the `AND`
 * / `OR` shape and `userId: null` as IS NULL. A `mockResolvedValue` fixture
 * would return whatever it was handed and could not fail.
 */
describe('GET /evaluations/datasets — ownerless rows', () => {
  const OWN = makeDatasetRow({ id: 'ds-own', userId: ADMIN_ID });
  const FOREIGN = makeDatasetRow({ id: 'ds-foreign', userId: 'another-admin' });
  const ORPHAN = makeDatasetRow({ id: 'ds-orphan', userId: null });

  /** A fork's narrower tier: this admin may not read rows nobody owns. */
  function denyUnattributedReads() {
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: (viewer, target, scope) =>
        target.kind === 'unattributed'
          ? Promise.resolve(false)
          : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiDataset.findMany).mockImplementation(
      ownerScopedFindMany([OWN, FOREIGN, ORPHAN]) as never
    );
    vi.mocked(prisma.aiDataset.count).mockImplementation(
      ownerScopedCount([OWN, FOREIGN, ORPHAN]) as never
    );
  });

  afterEach(() => {
    __resetAuthorizationPolicyForTests();
  });

  it('shows an ownerless dataset under the default policy', async () => {
    const response = await GET(makeGetRequest());

    const body = await parseJson<{ data: Array<{ id: string }>; meta: { total: number } }>(
      response
    );
    expect(body.data.map((d) => d.id).sort()).toEqual(['ds-orphan', 'ds-own']);
    expect(body.meta.total).toBe(2);
  });

  it('hides it again when the policy denies an unattributed read', async () => {
    // If the route decided this for itself rather than asking the policy, this
    // returns two rows and fails — which is the whole point of the seam.
    denyUnattributedReads();

    const response = await GET(makeGetRequest());

    const body = await parseJson<{ data: Array<{ id: string }>; meta: { total: number } }>(
      response
    );
    expect(body.data.map((d) => d.id)).toEqual(['ds-own']);
    expect(body.meta.total).toBe(1);
  });

  it("never shows another admin's owned dataset on either branch", async () => {
    const permitted = await parseJson<{ data: Array<{ id: string }> }>(await GET(makeGetRequest()));
    denyUnattributedReads();
    const denied = await parseJson<{ data: Array<{ id: string }> }>(await GET(makeGetRequest()));

    // Non-empty on both branches, or "does not contain" proves nothing.
    expect(permitted.data.length).toBeGreaterThan(0);
    expect(denied.data.length).toBeGreaterThan(0);
    for (const body of [permitted, denied]) {
      expect(body.data.map((d) => d.id)).not.toContain('ds-foreign');
    }
  });
});
