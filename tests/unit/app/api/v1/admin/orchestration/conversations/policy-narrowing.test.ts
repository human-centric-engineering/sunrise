/**
 * Cross-surface test: a fork narrows who reads a stranger's inbound messages.
 *
 * `conversation-access.ts` used to hard-code the answer — every admin read every
 * inbound thread. Right on a single-tenant install and indefensible under a
 * customer tier, where one tenant's admin would read another tenant's
 * customers' text messages. This file is the proof that a fork can now refuse
 * it (t-686), and that the surfaces move **together**.
 *
 * Together is the property, and it is why these share a file. The detail route
 * asks `adminCanViewConversation`; the list asks `conversationVisibilityWhere`;
 * the search route asks neither, because it is a pgvector query whose predicate
 * is hand-written SQL. Three spellings of one rule, and nothing mechanical
 * checks they agree — a list that shows an inbound thread whose detail route
 * 404s is exactly what the duplication produces.
 *
 * The real `withAdminAuth` runs: only `auth.api.getSession` is mocked, so the
 * guard resolves `session.unattributedReads` from the registered policy the way
 * a request does.
 *
 * The default-install direction lives in each route's own tests and in
 * `conversation-access.test.ts`; it is not repeated here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mocks (must precede any import that loads the mocked modules) ────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logConversationAccess: vi.fn(),
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedText: vi.fn(() => Promise.resolve({ embedding: [0.1, 0.2, 0.3] })),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
  },
}));

// ─── Imports (after vi.mock calls) ───────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  logConversationAccess,
  logAdminAction,
} from '@/lib/orchestration/audit/admin-audit-logger';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';
import { GET as listConversations } from '@/app/api/v1/admin/orchestration/conversations/route';
import {
  GET as conversationDetail,
  DELETE as deleteConversation,
} from '@/app/api/v1/admin/orchestration/conversations/[id]/route';
import { POST as clearConversations } from '@/app/api/v1/admin/orchestration/conversations/clear/route';
import { GET as searchConversations } from '@/app/api/v1/admin/orchestration/conversations/search/route';
import { conversationVisibilityWhere } from '@/lib/orchestration/access/conversation-access';
import type { AuthenticatedSession } from '@/lib/auth/guards';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const CONV_ID = 'cmjbv4i3x00003wsloputgwu9';

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

/** A session whose policy permits unattributed reads — the default install. */
function sessionAllowing(): AuthenticatedSession {
  return {
    user: { id: ADMIN_ID, role: 'ADMIN' },
    principal: { userId: ADMIN_ID, role: 'ADMIN', credential: 'session' },
    unattributedReads: { conversation: true, dataset: true, execution: true, experiment: true },
  } as unknown as AuthenticatedSession;
}

function makeRequest(path: string): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration${path}`,
    nextUrl: { pathname: `/api/v1/admin/orchestration${path}` },
  } as unknown as NextRequest;
}

function makeMutatingRequest(method: 'POST' | 'DELETE', path: string, body?: unknown): NextRequest {
  return {
    method,
    headers: new Headers({ 'content-type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration${path}`,
    nextUrl: { pathname: `/api/v1/admin/orchestration${path}` },
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

/** The arms of the visibility clause a route handed Prisma. */
function armsOf(where: unknown): Record<string, unknown>[] {
  const and = (where as { AND?: unknown[] }).AND;
  const clause = (and ? and[0] : where) as { OR: Record<string, unknown>[] };
  return clause.OR;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
  vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);
  vi.mocked(prisma.aiConversation.delete).mockResolvedValue({} as never);
  vi.mocked(prisma.aiConversation.deleteMany).mockResolvedValue({ count: 0 });
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

// ─── The three read surfaces ──────────────────────────────────────────────────

describe('a policy that denies unattributed reads', () => {
  beforeEach(registerNoUnattributedReads);

  it('drops inbound threads from the conversations list', async () => {
    const response = await listConversations(makeRequest('/conversations'));
    expect(response.status).toBe(200);

    const arms = armsOf(vi.mocked(prisma.aiConversation.findMany).mock.calls[0]?.[0]?.where);
    // Owner and share survive; the `{ userId: null }` arm is gone. Asserted as
    // the whole arm list, because an extra arm is a cross-tenant read.
    expect(arms).toHaveLength(2);
    expect(arms[0]).toEqual({ userId: ADMIN_ID });
    expect(arms.some((a) => 'userId' in a && a.userId === null)).toBe(false);
    expect(arms.some((a) => 'share' in a)).toBe(true);
  });

  it('drops them from semantic search, in the query rather than afterwards', async () => {
    const response = await searchConversations(makeRequest('/conversations/search?q=refund'));
    expect(response.status).toBe(200);

    const sql = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0]?.[0];
    // Filtered in SQL: post-filtering would return fewer than `limit` rows and
    // leak the omitted ones through the count.
    //
    // Asserted on the CONVERSATION's ownerless arm specifically, not on
    // `IS NULL` anywhere — the share subquery legitimately tests
    // `s."revokedAt" IS NULL` and `s."expiresAt" IS NULL`, so the loose form
    // failed here for the right reason and would have passed for the wrong one
    // had the arms been ordered differently.
    expect(sql).not.toContain('c."userId" IS NULL');
    // The other two arms are untouched — the owner bind and the share subquery.
    expect(sql).toContain('c."userId" = $4');
    expect(sql).toContain('ai_conversation_share');
  });

  it('404s the detail route for an inbound thread', async () => {
    // The list's narrowed clause does nothing here: this route fetches by id
    // and then asks. Before t-686 the thread opened.
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
      userId: null,
      share: null,
    } as never);

    const response = await conversationDetail(makeRequest(`/conversations/${CONV_ID}`), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(response.status).toBe(404);
  });

  it('still opens the caller’s own conversation', async () => {
    // The control. Without it the 404 above would pass just as well if the
    // detail route were broken in some unrelated way.
    vi.mocked(prisma.aiConversation.findUnique)
      .mockResolvedValueOnce({ userId: ADMIN_ID, share: null } as never)
      .mockResolvedValueOnce({ id: CONV_ID, title: 'Mine', userId: ADMIN_ID } as never);

    const response = await conversationDetail(makeRequest(`/conversations/${CONV_ID}`), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(response.status).toBe(200);
  });
});

// ─── The writes follow the same rule as the reads, on both routes ─────────────

/**
 * `canRead`'s ownerless arm decides writes as well as reads, and until t-691
 * the two write routes over an inbound thread disagreed about it: the targeted
 * `DELETE /conversations/:id` gated on the policy while `POST /conversations/clear`
 * with `allUsers` consulted nothing — so a narrowed admin was refused one
 * inbound thread and could destroy every inbound thread through the bulk route.
 *
 * These cases pin one rule against both routes, in both directions. They are in
 * one `describe` because the property is that the two AGREE; a case each in two
 * files would pass while the pair diverged, which is the shape this file exists
 * to catch.
 */
describe('writes over an inbound thread, targeted and bulk', () => {
  /** The `where` the bulk route handed `deleteMany`. */
  function bulkWhere(): Record<string, unknown> {
    const call = vi.mocked(prisma.aiConversation.deleteMany).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    return call!.where as Record<string, unknown>;
  }

  describe('under a policy that denies unattributed reads', () => {
    beforeEach(registerNoUnattributedReads);

    it('404s the targeted delete', async () => {
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue({
        userId: null,
        share: null,
      } as never);

      const response = await deleteConversation(
        makeMutatingRequest('DELETE', `/conversations/${CONV_ID}`),
        { params: Promise.resolve({ id: CONV_ID }) }
      );

      expect(response.status).toBe(404);
      expect(prisma.aiConversation.delete).not.toHaveBeenCalled();
    });

    it('leaves ownerless threads out of a bulk clear across all users', async () => {
      const response = await clearConversations(
        makeMutatingRequest('POST', '/conversations/clear', {
          allUsers: true,
          olderThan: '2025-01-01T00:00:00Z',
        })
      );

      expect(response.status).toBe(200);
      // `userId: { not: null }` is the whole of the narrowing — the same rows
      // the list omits, and nothing else. The `olderThan` filter beside it is
      // untouched, so the route still clears every OWNED thread it did before.
      expect(bulkWhere()).toEqual({
        userId: { not: null },
        createdAt: { lt: new Date('2025-01-01T00:00:00Z') },
      });
      // The immutable trail says so too. `scope: 'all'` alone would read, to a
      // compliance officer after an Art. 17 request, as "the inbound thread
      // was destroyed" — and it was not.
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'conversation.bulk_clear',
          metadata: expect.objectContaining({ scope: 'all', ownerlessExcluded: true }),
        })
      );
    });

    it('still clears the caller’s own threads, so the narrowing is only the ownerless arm', async () => {
      // The control for the case above: a bulk route that had simply started
      // refusing narrowed callers would pass it just as well.
      const response = await clearConversations(
        makeMutatingRequest('POST', '/conversations/clear', {
          olderThan: '2025-01-01T00:00:00Z',
        })
      );

      expect(response.status).toBe(200);
      expect(bulkWhere()).toEqual({
        userId: ADMIN_ID,
        createdAt: { lt: new Date('2025-01-01T00:00:00Z') },
      });
    });
  });

  describe('on a default install', () => {
    // No policy registered — the outer `afterEach` has reset it, so this is
    // the built-in rule, which admits platform staff to ownerless rows.
    it('deletes the inbound thread on the targeted route', async () => {
      vi.mocked(prisma.aiConversation.findUnique)
        .mockResolvedValueOnce({ userId: null, share: null } as never)
        .mockResolvedValueOnce({ title: 'Inbound from +44…' } as never);

      const response = await deleteConversation(
        makeMutatingRequest('DELETE', `/conversations/${CONV_ID}`),
        { params: Promise.resolve({ id: CONV_ID }) }
      );

      expect(response.status).toBe(200);
      expect(prisma.aiConversation.delete).toHaveBeenCalledWith({ where: { id: CONV_ID } });
      // Destroying a third party's messages is never routine self-service.
      expect(logConversationAccess).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'conversation.deleted', accessBasis: 'system' })
      );
    });

    it('reaches ownerless threads in a bulk clear across all users', async () => {
      const response = await clearConversations(
        makeMutatingRequest('POST', '/conversations/clear', {
          allUsers: true,
          olderThan: '2025-01-01T00:00:00Z',
        })
      );

      expect(response.status).toBe(200);
      // No `userId` key at all — a platform admin's `allUsers` is every
      // conversation, inbound threads included, exactly as before t-691.
      expect(bulkWhere()).toEqual({ createdAt: { lt: new Date('2025-01-01T00:00:00Z') } });
    });
  });
});

// ─── The audit trail must not narrow silently with the visibility ─────────────

describe('audit logging tracks the basis that admitted the row', () => {
  it('logs a shared read that a narrowing policy still admits', async () => {
    // The half of this task that could break quietly. Narrowing what an admin
    // may see narrows what gets logged, and the safe direction is "fewer rows
    // read, fewer rows logged". The unsafe one is a row read without a log —
    // so the surviving non-owner basis is pinned as still logging.
    registerNoUnattributedReads();
    vi.mocked(prisma.aiConversation.findUnique)
      .mockResolvedValueOnce({
        userId: 'someone-else',
        share: { revokedAt: null, expiresAt: null },
      } as never)
      .mockResolvedValueOnce({ id: CONV_ID, title: 'Theirs', userId: 'someone-else' } as never);

    const response = await conversationDetail(makeRequest(`/conversations/${CONV_ID}`), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(response.status).toBe(200);
    expect(logConversationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accessBasis: 'shared', conversationId: CONV_ID })
    );
  });

  it('logs a system read on a default install', async () => {
    // The basis that disappears under a narrowing policy still logs when the
    // policy permits it. A regression that stopped logging here would leave a
    // stranger's correspondence readable with no record of who read it.
    vi.mocked(prisma.aiConversation.findUnique)
      .mockResolvedValueOnce({ userId: null, share: null } as never)
      .mockResolvedValueOnce({ id: CONV_ID, title: 'Inbound', userId: null } as never);

    const response = await conversationDetail(makeRequest(`/conversations/${CONV_ID}`), {
      params: Promise.resolve({ id: CONV_ID }),
    });

    expect(response.status).toBe(200);
    expect(logConversationAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accessBasis: 'system' })
    );
  });
});

// ─── The SQL is a fourth spelling of the rule, so pin it against the third ────

describe('the search route’s SQL and the Prisma fragment agree', () => {
  // Round 2 of review found this group missing, and found the comment claiming
  // it existed. Before it, deleting `ownerlessArm` outright left every test in
  // the repo green while semantic search silently stopped returning inbound
  // threads on a DEFAULT install — the only SQL assertion anywhere was the
  // negative one above, which passes when the arm is gone for the wrong reason.

  async function sqlFor(policy: 'default' | 'narrowed'): Promise<string> {
    // Cleared per call, not per test: two invocations in one test otherwise
    // accumulate on the same mock and `calls[0]` hands back the FIRST query.
    // The delta assertion below caught exactly that, which is the argument for
    // comparing the two strings rather than asserting on each separately.
    vi.mocked(prisma.$queryRawUnsafe).mockClear();
    __resetAuthorizationPolicyForTests();
    if (policy === 'narrowed') registerNoUnattributedReads();
    await searchConversations(makeRequest('/conversations/search?q=refund'));
    return vi.mocked(prisma.$queryRawUnsafe).mock.calls[0]?.[0];
  }

  it('emits the ownerless arm on a default install', async () => {
    // The positive half. Without it, "the arm is absent" passes whether the
    // policy refused it or somebody deleted it.
    expect(await sqlFor('default')).toContain('c."userId" IS NULL');
  });

  it('omits it, and nothing else, when the policy refuses', async () => {
    const [allowed, refused] = [await sqlFor('default'), await sqlFor('narrowed')];
    // Exactly one difference between the two, and it is the arm. Asserted as a
    // string delta rather than two `toContain`s, so an edit that also changed
    // the share subquery under a narrowing policy could not slip through.
    expect(allowed.replace(' OR c."userId" IS NULL', '')).toBe(refused);
  });

  it('spells the active-share test the same way the fragment does', async () => {
    // The rule exists twice by construction: Prisma takes data, not a function,
    // and a pgvector distance query is not expressible through its builder. So
    // the copies are compared here — including `>` against `gt`, which is the
    // character that decides whether a share expiring exactly now shows in a
    // list whose detail route refuses it.
    const sql = await sqlFor('default');
    const arm = (
      conversationVisibilityWhere(sessionAllowing()) as {
        OR: { share?: { revokedAt: null; OR: { expiresAt: unknown }[] } }[];
      }
    ).OR.find((a) => a.share)!;

    expect(arm.share!.revokedAt).toBeNull();
    expect(sql).toContain('s."revokedAt" IS NULL');

    expect(arm.share!.OR[0]).toEqual({ expiresAt: null });
    expect(sql).toContain('s."expiresAt" IS NULL');

    expect(Object.keys(arm.share!.OR[1].expiresAt as object)).toEqual(['gt']);
    expect(sql).toContain('s."expiresAt" > NOW()');
    expect(sql).not.toContain('s."expiresAt" >= NOW()');
  });

  it('excludes ownerless rows from the share arm, as the helper does', async () => {
    // `adminCanViewConversation` decides an ownerless row on the policy alone
    // and never reaches its share check. Both set-forms must match, or a row
    // that is ownerless AND shared appears in a list that 404s on click.
    const arm = (
      conversationVisibilityWhere(sessionAllowing()) as { OR: Record<string, unknown>[] }
    ).OR.find((a) => 'share' in a)!;
    expect(arm.userId).toEqual({ not: null });
    expect(await sqlFor('default')).toContain('c."userId" IS NOT NULL AND EXISTS');
  });
});
