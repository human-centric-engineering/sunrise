/**
 * Cross-surface test: a fork narrows who reads a stranger's inbound messages,
 * and the analytics routes move with the conversation routes.
 *
 * Until t-694 they did not. A fork registered a narrowing `canRead`, confirmed
 * an inbound thread 404d on every conversation route, and concluded the
 * correspondence was contained — while `/analytics/unanswered` still handed
 * the same admin the sender's question verbatim, because the analytics service
 * read `AiMessage` and `AiConversation` with no policy in the loop.
 *
 * Five routes share this file because the property is that they AGREE: one
 * aggregate that still counts an inbound thread is the leak, and a case each
 * in five files would pass while the set diverged.
 *
 * What is asserted is the RESPONSE, not the `where`. The Prisma mocks here are
 * filtering fakes over a two-conversation fixture — one owned by a member, one
 * inbound and ownerless — so a route that stopped excluding the ownerless
 * thread in its query would return the sender's words here and fail. The
 * `where` shapes on every read are `analytics-service.test.ts`'s job.
 *
 * The real `withAdminAuth` runs: only `auth.api.getSession` is mocked, so the
 * guard resolves `session.unattributedReads` from the registered policy the way
 * a request does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mocks (must precede any import that loads the mocked modules) ────────────

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    aiMessage: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports (after vi.mock calls) ───────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import {
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';
import { GET as topics } from '@/app/api/v1/admin/orchestration/analytics/topics/route';
import { GET as unanswered } from '@/app/api/v1/admin/orchestration/analytics/unanswered/route';
import { GET as engagement } from '@/app/api/v1/admin/orchestration/analytics/engagement/route';
import { GET as contentGaps } from '@/app/api/v1/admin/orchestration/analytics/content-gaps/route';
import { GET as feedback } from '@/app/api/v1/admin/orchestration/analytics/feedback/route';

// ─── Fixture: one owned thread, one inbound ───────────────────────────────────

const MEMBER_ID = 'cmjbv4i3x00003wsloputgwm1';
const AGENT_ID = 'cmjbv4i3x00003wsloputgwa1';
const OWNED_ID = 'cmjbv4i3x00003wsloputgwc1';
const INBOUND_ID = 'cmjbv4i3x00003wsloputgwc2';

/** The words that must not reach a caller the policy refuses. */
const SENDER_TEXT = 'my card ends 4242, was the refund sent to it?';
const MEMBER_TEXT = 'Where is my order?';

const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
const later = new Date(yesterday.getTime() + 60_000);

interface Conversation {
  id: string;
  userId: string | null;
  agentId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  rating: number | null;
  ratedAt: Date | null;
}

const CONVERSATIONS: Conversation[] = [
  {
    id: OWNED_ID,
    userId: MEMBER_ID,
    agentId: AGENT_ID,
    title: null,
    createdAt: yesterday,
    updatedAt: later,
  },
  {
    id: INBOUND_ID,
    userId: null,
    agentId: AGENT_ID,
    title: null,
    createdAt: yesterday,
    updatedAt: later,
  },
];

// Both threads carry the same shape: a question, then a hedging reply the
// member rated down. So every aggregate has one contribution from each, and
// "the inbound one is gone" is a count of exactly one on every route.
const MESSAGES: Message[] = [
  message('m1', OWNED_ID, 'user', MEMBER_TEXT, yesterday),
  message('m2', OWNED_ID, 'assistant', "I don't know", later, -1),
  message('m3', INBOUND_ID, 'user', SENDER_TEXT, yesterday),
  message('m4', INBOUND_ID, 'assistant', "I'm not sure", later, -1),
];

function message(
  id: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: Date,
  rating: number | null = null
): Message {
  return {
    id,
    conversationId,
    role,
    content,
    createdAt,
    rating,
    ratedAt: rating ? createdAt : null,
  };
}

// ─── Filtering fakes ──────────────────────────────────────────────────────────

type Where = Record<string, unknown>;

/**
 * Applies the one clause under test — `userId: { not: null }` on the
 * conversation — plus the filters the service composes beside it (`agentId`,
 * `role`, `conversationId: { in }`, `rating`). Dates and the hedging `OR` are
 * not modelled: every fixture is in range and every reply hedges, so they
 * would admit everything anyway.
 */
function conversationAdmitted(conversation: Conversation, where: Where | undefined): boolean {
  if (!where) return true;
  if ('agentId' in where && where.agentId !== conversation.agentId) return false;
  if ('userId' in where) {
    const userId = where.userId as { not?: unknown } | string | null;
    if (userId !== null && typeof userId === 'object' && userId.not === null) {
      return conversation.userId !== null;
    }
    // Any other shape is an owner filter, which a deployment-wide reader must
    // never emit — fail loudly rather than model it.
    throw new Error(
      `unexpected userId clause on a deployment-wide read: ${JSON.stringify(userId)}`
    );
  }
  return true;
}

function conversationOf(m: Message): Conversation {
  return CONVERSATIONS.find((c) => c.id === m.conversationId)!;
}

function messageAdmitted(m: Message, where: Where): boolean {
  if ('role' in where && where.role !== m.role) return false;
  const idFilter = where.conversationId as { in?: string[] } | undefined;
  if (idFilter?.in && !idFilter.in.includes(m.conversationId)) return false;
  if ('rating' in where) {
    const rating = where.rating as number | { not: null };
    if (typeof rating === 'number' ? m.rating !== rating : m.rating === null) return false;
  }
  return conversationAdmitted(conversationOf(m), where.conversation as Where | undefined);
}

function messageRow(m: Message) {
  const conversation = conversationOf(m);
  return { ...m, conversation: { agentId: conversation.agentId, agent: { name: 'Support' } } };
}

function conversationRow(c: Conversation) {
  return {
    ...c,
    messages: MESSAGES.filter((m) => m.conversationId === c.id).map(({ role, content }) => ({
      role,
      content,
    })),
  };
}

function installFakes(): void {
  vi.mocked(prisma.aiMessage.findMany).mockImplementation(((args: { where: Where }) =>
    Promise.resolve(
      MESSAGES.filter((m) => messageAdmitted(m, args.where)).map(messageRow)
    )) as never);
  vi.mocked(prisma.aiMessage.count).mockImplementation(((args: { where: Where }) =>
    Promise.resolve(MESSAGES.filter((m) => messageAdmitted(m, args.where)).length)) as never);
  vi.mocked(prisma.aiConversation.findMany).mockImplementation(((args: { where: Where }) =>
    Promise.resolve(
      CONVERSATIONS.filter((c) => conversationAdmitted(c, args.where)).map(conversationRow)
    )) as never);
  vi.mocked(prisma.aiConversation.count).mockImplementation(((args: { where: Where }) =>
    Promise.resolve(
      CONVERSATIONS.filter((c) => conversationAdmitted(c, args.where)).length
    )) as never);
  vi.mocked(prisma.aiConversation.groupBy).mockResolvedValue([] as never);
}

// ─── Driving the routes ───────────────────────────────────────────────────────

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
    url: `http://localhost:3000/api/v1/admin/orchestration/analytics${path}`,
    nextUrl: { pathname: `/api/v1/admin/orchestration/analytics${path}` },
  } as unknown as NextRequest;
}

async function body<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (JSON.parse(await response.text()) as { data: T }).data;
}

interface Unanswered {
  questions: Array<{ userMessage: string; assistantReply: string }>;
}
interface Topics {
  topics: Array<{ content: string }>;
}
interface Engagement {
  metrics: { totalConversations: number; totalMessages: number };
}
interface Gaps {
  gaps: Array<{ topic: string }>;
}
interface Feedback {
  feedback: { overall: { total: number }; recentNegative: Array<{ userMessage: string }> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  installFakes();
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

// ─── A policy that refuses unattributed reads ─────────────────────────────────

describe('a policy that denies unattributed reads', () => {
  beforeEach(registerNoUnattributedReads);

  it('unanswered: the inbound sender’s question is not returned', async () => {
    const response = await unanswered(makeRequest('/unanswered'));
    const text = await response.clone().text();
    const { questions } = await body<Unanswered>(response);

    expect(questions).toHaveLength(1);
    expect(questions[0]?.userMessage).toBe(MEMBER_TEXT);
    // Not in the reply field, not in any field — the sender's words are what
    // the policy refused, so the whole body is checked.
    expect(text).not.toContain(SENDER_TEXT);
  });

  it('topics: the inbound question is not a topic', async () => {
    const { topics: list } = await body<Topics>(await topics(makeRequest('/topics')));
    expect(list.map((t) => t.content)).toEqual([MEMBER_TEXT]);
  });

  it('engagement: the inbound thread and its messages are not counted', async () => {
    const { metrics } = await body<Engagement>(await engagement(makeRequest('/engagement')));
    expect(metrics.totalConversations).toBe(1);
    expect(metrics.totalMessages).toBe(2);
  });

  it('content-gaps: the inbound thread contributes no gap', async () => {
    const { gaps } = await body<Gaps>(await contentGaps(makeRequest('/content-gaps')));
    expect(gaps.map((g) => g.topic)).toEqual([MEMBER_TEXT]);
  });

  it('feedback: the inbound thread’s rating and its question are gone', async () => {
    const response = await feedback(makeRequest('/feedback'));
    const text = await response.clone().text();
    const { feedback: summary } = await body<Feedback>(response);

    expect(summary.overall.total).toBe(1);
    expect(summary.recentNegative.map((n) => n.userMessage)).toEqual([MEMBER_TEXT]);
    expect(text).not.toContain(SENDER_TEXT);
  });

  it('still aggregates the member’s thread, which is nobody’s own and not ownerless', async () => {
    // The control, and the fact the task had wrong: the member's chat with a
    // public agent is outside `conversationVisibilityWhere` for this admin —
    // not theirs, not shared, not ownerless — and inside the aggregate. A
    // service narrowed to the per-caller set would return nothing here and
    // pass every case above.
    const { questions } = await body<Unanswered>(await unanswered(makeRequest('/unanswered')));
    expect(questions).toHaveLength(1);
    expect(questions[0]?.userMessage).toBe(MEMBER_TEXT);
  });
});

// ─── A default install ────────────────────────────────────────────────────────

describe('on a default install', () => {
  // No policy registered — the outer `afterEach` has reset it, so this is the
  // built-in rule, which admits platform staff to ownerless rows. Every number
  // is what it was before the arm existed: both threads, four messages.

  it('unanswered: returns both questions, the inbound sender’s included', async () => {
    const { questions } = await body<Unanswered>(await unanswered(makeRequest('/unanswered')));
    expect(questions.map((q) => q.userMessage).sort()).toEqual([MEMBER_TEXT, SENDER_TEXT].sort());
  });

  it('topics, engagement, content-gaps and feedback count both threads', async () => {
    const { topics: list } = await body<Topics>(await topics(makeRequest('/topics')));
    expect(list).toHaveLength(2);

    const { metrics } = await body<Engagement>(await engagement(makeRequest('/engagement')));
    expect(metrics.totalConversations).toBe(2);
    expect(metrics.totalMessages).toBe(4);

    const { gaps } = await body<Gaps>(await contentGaps(makeRequest('/content-gaps')));
    expect(gaps).toHaveLength(2);

    const { feedback: summary } = await body<Feedback>(await feedback(makeRequest('/feedback')));
    expect(summary.overall.total).toBe(2);
    expect(summary.recentNegative).toHaveLength(2);
  });
});
