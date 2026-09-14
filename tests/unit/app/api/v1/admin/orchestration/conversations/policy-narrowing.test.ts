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
    aiConversation: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
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
import { logConversationAccess } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';
import { GET as listConversations } from '@/app/api/v1/admin/orchestration/conversations/route';
import { GET as conversationDetail } from '@/app/api/v1/admin/orchestration/conversations/[id]/route';
import { GET as searchConversations } from '@/app/api/v1/admin/orchestration/conversations/search/route';

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

function makeRequest(path: string): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration${path}`,
    nextUrl: { pathname: `/api/v1/admin/orchestration${path}` },
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
