/**
 * Integration Test: moving a model's uses to its replacement (§136 t-1066)
 *
 * POST /api/v1/admin/orchestration/provider-models/:id/move-uses/preview
 * POST /api/v1/admin/orchestration/provider-models/:id/move-uses
 *
 * The routes run through the real guard and the real `loadMoveTarget`, so
 * the replacement rule (`checkReplacement`) is the one that refuses: a model
 * on another provider, one being retired, one that does not exist. The walk
 * over the orgs is `move.ts`'s and has its own tests; here it is stubbed to
 * show what the routes pass it and answer with.
 *
 * @see app/api/v1/admin/orchestration/provider-models/[id]/move-uses/route.ts
 * @see app/api/v1/admin/orchestration/provider-models/[id]/move-uses/preview/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderModel: { findUnique: vi.fn(), findMany: vi.fn(() => Promise.resolve([])) },
    aiAdminAuditLog: { create: vi.fn(() => Promise.resolve({})) },
  },
}));

vi.mock('@/lib/orchestration/model-lifecycle/move', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/model-lifecycle/move')>()),
  previewModelMove: vi.fn(),
  moveModelUses: vi.fn(),
}));

import { auth } from '@/lib/auth/config';
import { ConflictError } from '@/lib/api/errors';
import { prisma } from '@/lib/db/client';
import { moveModelUses, previewModelMove } from '@/lib/orchestration/model-lifecycle/move';
import { POST as MOVE } from '@/app/api/v1/admin/orchestration/provider-models/[id]/move-uses/route';
import { POST as PREVIEW } from '@/app/api/v1/admin/orchestration/provider-models/[id]/move-uses/preview/route';

const MODEL_ID = 'cmjbv4i3x00003wsloputmold';
const REPLACEMENT_ID = 'cmjbv4i3x00003wsloputmnew';
const AZURE_ID = 'cmjbv4i3x00003wsloputmazr';

const ROWS: Record<string, unknown> = {
  [MODEL_ID]: {
    id: MODEL_ID,
    name: 'GPT-4o',
    providerSlug: 'openai',
    modelId: 'gpt-4o',
    capabilities: ['chat'],
    isActive: true,
    retiresAt: new Date('2027-06-01T00:00:00Z'),
  },
  [REPLACEMENT_ID]: {
    id: REPLACEMENT_ID,
    name: 'GPT-4.1',
    providerSlug: 'openai',
    modelId: 'gpt-4.1',
    capabilities: ['chat', 'tools'],
    isActive: true,
    retiresAt: null,
  },
  [AZURE_ID]: {
    id: AZURE_ID,
    name: 'Azure GPT-4.1',
    providerSlug: 'microsoft',
    modelId: 'gpt-4.1',
    capabilities: ['chat'],
    isActive: true,
    retiresAt: null,
  },
};

const BASE = 'http://localhost:3000/api/v1/admin/orchestration/provider-models';

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(new URL(`${BASE}/${MODEL_ID}/${path}`), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
  });
}

const context = { params: Promise.resolve({ id: MODEL_ID }) };

type Handler = (req: NextRequest, ctx: typeof context) => Promise<Response>;
const ROUTES: Array<[string, Handler, string]> = [
  ['preview', PREVIEW, 'move-uses/preview'],
  ['move', MOVE, 'move-uses'],
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  vi.mocked(prisma.aiProviderModel.findUnique).mockImplementation(((args: {
    where: { id: string };
  }) => Promise.resolve(ROWS[args.where.id] ?? null)) as never);
});

describe.each(ROUTES)('POST …/move-uses (%s)', (_name, handler, path) => {
  it('refuses the unauthenticated and non-admins', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    expect((await handler(post(path, { replacementId: REPLACEMENT_ID }), context)).status).toBe(
      401
    );
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await handler(post(path, { replacementId: REPLACEMENT_ID }), context)).status).toBe(
      403
    );
    expect(previewModelMove).not.toHaveBeenCalled();
    expect(moveModelUses).not.toHaveBeenCalled();
  });

  it('refuses a replacement on another provider, before anything is read or moved', async () => {
    const response = await handler(post(path, { replacementId: AZURE_ID }), context);
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details: { replacementId: string[] } };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.replacementId[0]).toBe(
      'The replacement must be on the same provider (openai); "Azure GPT-4.1" is on microsoft'
    );
    expect(previewModelMove).not.toHaveBeenCalled();
    expect(moveModelUses).not.toHaveBeenCalled();
  });

  it('refuses a body without a replacement, and an unknown model', async () => {
    expect((await handler(post(path, {}), context)).status).toBe(400);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);
    expect((await handler(post(path, { replacementId: REPLACEMENT_ID }), context)).status).toBe(
      404
    );
  });
});

describe('POST …/move-uses/preview', () => {
  it('answers the preview for the checked pair', async () => {
    const preview = { orgs: [], settings: { moved: [], left: [] }, suspendedOrgs: 0 };
    vi.mocked(previewModelMove).mockResolvedValue(preview as never);

    const response = await PREVIEW(
      post('move-uses/preview', { replacementId: REPLACEMENT_ID }),
      context
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown }).data).toEqual(preview);
    const [target] = vi.mocked(previewModelMove).mock.calls[0];
    expect(target.model.id).toBe(MODEL_ID);
    expect(target.replacement.id).toBe(REPLACEMENT_ID);
    expect(moveModelUses).not.toHaveBeenCalled();
  });
});

describe('POST …/move-uses', () => {
  it('moves, as the admin who asked, and answers every org’s outcome', async () => {
    const result = {
      orgs: [{ orgId: 'org-b', name: 'Bolt', status: 'skipped', reason: 'x', agents: 0 }],
      totals: { agents: 2, workflows: 1, settings: 1, skipped: 1, failed: 0 },
    };
    vi.mocked(moveModelUses).mockResolvedValue(result as never);

    const response = await MOVE(post('move-uses', { replacementId: REPLACEMENT_ID }), context);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown }).data).toEqual(result);
    const [target, actor] = vi.mocked(moveModelUses).mock.calls[0];
    expect(target.replacement.modelId).toBe('gpt-4.1');
    expect(actor).toEqual({ userId: mockAdminUser().user.id, clientIp: '203.0.113.9' });
  });
});

describe('POST …/move-uses — the app refuses (§136 t-1067)', () => {
  it('answers 409 with the app’s reason', async () => {
    vi.mocked(moveModelUses).mockRejectedValue(
      new ConflictError('GPT-4.1 failed the contract panel', { refusedBy: 'app' })
    );

    const response = await MOVE(post('move-uses', { replacementId: REPLACEMENT_ID }), context);

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; message: string; details: unknown };
    };
    expect(body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'GPT-4.1 failed the contract panel',
      details: { refusedBy: 'app' },
    });
  });
});
