/**
 * Tests for `lib/orchestration/analytics/analytics-service.ts`.
 *
 * Covers:
 *   - getPopularTopics: case-insensitive grouping, date range, agent filter, limit
 *   - getUnansweredQuestions: hedging detection, batched user message lookup, empty results
 *   - getEngagementMetrics: counts, averages, returning users, daily trend
 *   - getContentGaps: gap ratio calculation, filtering, sorting
 *   - getFeedbackSummary: overall counts, per-agent breakdown, recent negative
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiMessage: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    aiConversation: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  getPopularTopics,
  getUnansweredQuestions,
  getEngagementMetrics,
  getContentGaps,
  getFeedbackSummary,
} from '@/lib/orchestration/analytics/analytics-service';
import { prisma } from '@/lib/db/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';

// ─── Helpers ────────────────────────────────────────────────────────────────

const baseQuery = {
  from: '2026-04-01',
  to: '2026-04-19',
};

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';

/**
 * The guard's answer on the one arm the policy decides. `mayReadUnowned: true`
 * is the default install; `false` is a fork whose policy refuses this caller
 * threads nobody owns. Every function takes the session for that field alone —
 * analytics aggregate every user's threads by design and never scope to the
 * caller, which is why no test here asserts on `ADMIN_ID` (t-694).
 */
function sessionFor(mayReadUnowned: boolean): AuthenticatedSession {
  return {
    user: { id: ADMIN_ID, role: 'ADMIN' },
    principal: { userId: ADMIN_ID, role: 'ADMIN', credential: 'session' },
    unattributedReads: {
      conversation: mayReadUnowned,
      dataset: true,
      execution: true,
      experiment: true,
    },
  } as unknown as AuthenticatedSession;
}

const admin = sessionFor(true);
const narrowedAdmin = sessionFor(false);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('getPopularTopics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('groups messages case-insensitively and sorts by count', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([
      { content: 'How do I reset?', createdAt: new Date('2026-04-10') },
      { content: 'how do i reset?', createdAt: new Date('2026-04-12') },
      { content: 'HOW DO I RESET?', createdAt: new Date('2026-04-14') },
      { content: 'What is pricing?', createdAt: new Date('2026-04-11') },
    ] as never);

    const result = await getPopularTopics(baseQuery, admin);

    expect(result).toHaveLength(2);
    // "reset" group has 3 occurrences
    expect(result[0].count).toBe(3);
    // Uses the most recent casing (from 2026-04-14)
    expect(result[0].content).toBe('HOW DO I RESET?');
    expect(result[1].content).toBe('What is pricing?');
    expect(result[1].count).toBe(1);
  });

  it('returns empty array when no messages exist', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    const result = await getPopularTopics(baseQuery, admin);
    expect(result).toEqual([]);
  });

  it('respects limit parameter', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([
      { content: 'A', createdAt: new Date() },
      { content: 'B', createdAt: new Date() },
      { content: 'C', createdAt: new Date() },
    ] as never);

    const result = await getPopularTopics({ ...baseQuery, limit: 2 }, admin);

    expect(result).toHaveLength(2);
  });

  it('filters by agentId when provided', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    await getPopularTopics({ ...baseQuery, agentId: 'cmjbv4i3x00003wsloputgwul' }, admin);

    expect(prisma.aiMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversation: expect.objectContaining({ agentId: 'cmjbv4i3x00003wsloputgwul' }),
        }),
      })
    );
  });

  it('defaults to 30-day range when no dates provided', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    await getPopularTopics({}, admin);

    expect(prisma.aiMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      })
    );
  });

  it('trims whitespace when grouping', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([
      { content: '  hello  ', createdAt: new Date() },
      { content: 'hello', createdAt: new Date() },
    ] as never);

    const result = await getPopularTopics(baseQuery, admin);

    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(2);
  });
});

describe('getUnansweredQuestions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('finds hedging messages and batches user message lookup', async () => {
    // First call: hedging messages
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([
      {
        id: 'msg_1',
        content: "I don't know the answer to that question.",
        createdAt: new Date('2026-04-10T10:00:00Z'),
        conversationId: 'conv_1',
        conversation: { agentId: 'agent_1' },
      },
    ] as never);

    // Second call: batch user messages for conv_1
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([
      {
        conversationId: 'conv_1',
        content: 'What is the meaning of life?',
        createdAt: new Date('2026-04-10T09:59:00Z'),
      },
    ] as never);

    const result = await getUnansweredQuestions(baseQuery, admin);

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg_1');
    expect(result[0].userMessage).toBe('What is the meaning of life?');
    expect(result[0].assistantReply).toContain("I don't know");
    expect(result[0].conversationId).toBe('conv_1');

    // Verify batch fetch was used (2 findMany calls total, no findFirst)
    expect(prisma.aiMessage.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.aiMessage.findFirst).not.toHaveBeenCalled();
  });

  it('returns empty array when no hedging messages found', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([] as never);

    const result = await getUnansweredQuestions(baseQuery, admin);
    expect(result).toEqual([]);
  });

  it('handles missing preceding user message gracefully', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([
      {
        id: 'msg_1',
        content: "I'm not sure about that.",
        createdAt: new Date('2026-04-10T10:00:00Z'),
        conversationId: 'conv_1',
        conversation: { agentId: 'agent_1' },
      },
    ] as never);

    // Batch user messages: none found
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([] as never);

    const result = await getUnansweredQuestions(baseQuery, admin);

    expect(result[0].userMessage).toBe('');
  });

  it('finds the correct preceding user message when multiple exist', async () => {
    const hedgingTime = new Date('2026-04-10T10:00:00Z');

    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([
      {
        id: 'msg_hedge',
        content: "I don't have information about that.",
        createdAt: hedgingTime,
        conversationId: 'conv_1',
        conversation: { agentId: 'agent_1' },
      },
    ] as never);

    // User messages ordered desc by createdAt
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([
      {
        conversationId: 'conv_1',
        content: 'Second question',
        createdAt: new Date('2026-04-10T09:59:00Z'),
      },
      {
        conversationId: 'conv_1',
        content: 'First question',
        createdAt: new Date('2026-04-10T09:50:00Z'),
      },
    ] as never);

    const result = await getUnansweredQuestions(baseQuery, admin);

    // Should pick the latest user msg before the hedging reply
    expect(result[0].userMessage).toBe('Second question');
  });
});

describe('getEngagementMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes all engagement metrics correctly', async () => {
    vi.mocked(prisma.aiConversation.count).mockResolvedValue(10);
    vi.mocked(prisma.aiMessage.count).mockResolvedValue(50);

    // Unique users
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValueOnce([
      { userId: 'u1' },
      { userId: 'u2' },
      { userId: 'u3' },
    ] as never);

    // Returning users
    vi.mocked(prisma.aiConversation.groupBy).mockResolvedValue([
      { userId: 'u1', _count: { id: 3 } },
      { userId: 'u2', _count: { id: 2 } },
    ] as never);

    // Daily conversations
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValueOnce([
      { createdAt: new Date('2026-04-15T10:00:00Z') },
      { createdAt: new Date('2026-04-15T14:00:00Z') },
      { createdAt: new Date('2026-04-16T09:00:00Z') },
    ] as never);

    const result = await getEngagementMetrics(baseQuery, admin);

    expect(result.totalConversations).toBe(10);
    expect(result.totalMessages).toBe(50);
    expect(result.uniqueUsers).toBe(3);
    expect(result.avgMessagesPerConversation).toBe(5);
    expect(result.returningUsers).toBe(2);
    expect(result.returningUserRate).toBeCloseTo(0.667, 2);
    expect(result.conversationsByDay).toHaveLength(2);
    expect(result.conversationsByDay[0]).toEqual({ date: '2026-04-15', count: 2 });
    expect(result.conversationsByDay[1]).toEqual({ date: '2026-04-16', count: 1 });
  });

  it('returns zeros when no data exists', async () => {
    vi.mocked(prisma.aiConversation.count).mockResolvedValue(0);
    vi.mocked(prisma.aiMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiConversation.groupBy).mockResolvedValue([] as never);

    const result = await getEngagementMetrics(baseQuery, admin);

    expect(result.totalConversations).toBe(0);
    expect(result.uniqueUsers).toBe(0);
    expect(result.avgMessagesPerConversation).toBe(0);
    expect(result.returningUserRate).toBe(0);
    expect(result.conversationsByDay).toEqual([]);
  });
});

describe('getContentGaps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('identifies topics with hedging responses', async () => {
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([
      {
        id: 'conv_1',
        title: 'Password reset',
        messages: [
          { role: 'user', content: 'How do I reset my password?' },
          { role: 'assistant', content: "I don't know how to help with that." },
        ],
      },
      {
        id: 'conv_2',
        title: 'Pricing',
        messages: [
          { role: 'user', content: 'What is the pricing?' },
          { role: 'assistant', content: 'Our plans start at $10/month.' },
        ],
      },
    ] as never);

    const result = await getContentGaps(baseQuery, admin);

    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('Password reset');
    expect(result[0].gapRatio).toBe(1);
    expect(result[0].unansweredCount).toBe(1);
  });

  it('returns empty array when no gaps exist', async () => {
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([
      {
        id: 'conv_1',
        title: 'Pricing',
        messages: [
          { role: 'user', content: 'What is the pricing?' },
          { role: 'assistant', content: 'Our plans start at $10/month.' },
        ],
      },
    ] as never);

    const result = await getContentGaps(baseQuery, admin);
    expect(result).toEqual([]);
  });

  it('uses first user message when no title exists', async () => {
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([
      {
        id: 'conv_1',
        title: null,
        messages: [
          { role: 'user', content: 'Tell me about refund policies' },
          { role: 'assistant', content: "I'm not sure about our refund policy." },
        ],
      },
    ] as never);

    const result = await getContentGaps(baseQuery, admin);

    expect(result[0].topic).toBe('Tell me about refund policies');
  });

  it('sorts by gap ratio descending', async () => {
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([
      {
        id: 'conv_1',
        title: 'Topic A',
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: "I don't know" },
        ],
      },
      {
        id: 'conv_2',
        title: 'Topic A',
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'Sure, here is the answer.' },
        ],
      },
      {
        id: 'conv_3',
        title: 'Topic B',
        messages: [
          { role: 'user', content: 'B' },
          { role: 'assistant', content: "I don't know" },
        ],
      },
    ] as never);

    const result = await getContentGaps(baseQuery, admin);

    // Topic B has 100% gap ratio (1/1), Topic A has 50% (1/2)
    expect(result[0].topic).toBe('Topic B');
    expect(result[0].gapRatio).toBe(1);
    expect(result[1].topic).toBe('Topic A');
    expect(result[1].gapRatio).toBe(0.5);
  });
});

describe('getFeedbackSummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes overall and per-agent feedback stats', async () => {
    // Overall counts
    vi.mocked(prisma.aiMessage.count)
      .mockResolvedValueOnce(8) // thumbsUp
      .mockResolvedValueOnce(2); // thumbsDown

    // Per-agent breakdown
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([
      { rating: 1, conversation: { agentId: 'a1', agent: { name: 'Agent One' } } },
      { rating: 1, conversation: { agentId: 'a1', agent: { name: 'Agent One' } } },
      { rating: -1, conversation: { agentId: 'a1', agent: { name: 'Agent One' } } },
      { rating: 1, conversation: { agentId: 'a2', agent: { name: 'Agent Two' } } },
    ] as never);

    // Recent negative
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([
      {
        id: 'msg_1',
        content: 'Bad answer',
        createdAt: new Date('2026-04-15T10:00:00Z'),
        ratedAt: new Date('2026-04-15T10:00:00Z'),
        conversationId: 'conv_1',
        conversation: { agentId: 'a1' },
      },
    ] as never);

    // Batch user messages for negative feedback context
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValueOnce([
      {
        conversationId: 'conv_1',
        content: 'What is the pricing?',
        createdAt: new Date('2026-04-15T09:59:00Z'),
      },
    ] as never);

    const result = await getFeedbackSummary(baseQuery, admin);

    expect(result.overall.thumbsUp).toBe(8);
    expect(result.overall.thumbsDown).toBe(2);
    expect(result.overall.total).toBe(10);
    expect(result.overall.satisfactionRate).toBe(0.8);

    expect(result.byAgent).toHaveLength(2);
    // Sorted by total desc — Agent One has 3 ratings, Agent Two has 1
    expect(result.byAgent[0].agentName).toBe('Agent One');
    expect(result.byAgent[0].thumbsUp).toBe(2);
    expect(result.byAgent[0].thumbsDown).toBe(1);

    expect(result.recentNegative).toHaveLength(1);
    expect(result.recentNegative[0].content).toBe('Bad answer');
    expect(result.recentNegative[0].userMessage).toBe('What is the pricing?');
  });

  it('returns null satisfactionRate when no ratings exist', async () => {
    vi.mocked(prisma.aiMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    const result = await getFeedbackSummary(baseQuery, admin);

    expect(result.overall.total).toBe(0);
    expect(result.overall.satisfactionRate).toBeNull();
    expect(result.byAgent).toEqual([]);
    expect(result.recentNegative).toEqual([]);
  });
});

// ─── The policy's ownerless arm is on every read ────────────────────────────

/**
 * Deployment-wide by design; the policy still decides the ownerless arm. These
 * cases pin two things about EVERY Prisma read the service makes, across all
 * five functions: under a refusing policy it carries `userId: { not: null }` on
 * the conversation, and on a default install it carries no `userId` key at all
 * — the second being what makes the cases above, which run with the default
 * session, the proof that a default install's numbers do not move.
 *
 * "Every read" includes the follow-up queries keyed on ids from an
 * already-scoped result. They are safe by construction today; asserting the
 * clause on them too is what lets this loop have no carve-out.
 */
describe('the ownerless arm, on every read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every read returns one row shaped well enough for the follow-up queries
    // to run — a hedging reply and a negative rating both point at CONV_ID, so
    // the second-stage `conversationId: { in }` queries are issued, not skipped.
    const CONV_ID = 'cmjbv4i3x00003wsloputgwu9';
    const message = {
      id: 'msg-1',
      content: "I don't know",
      role: 'assistant',
      rating: -1,
      createdAt: new Date('2026-04-10'),
      ratedAt: new Date('2026-04-10'),
      conversationId: CONV_ID,
      conversation: { agentId: 'agent-1', agent: { name: 'Agent' } },
    };
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([message] as never);
    vi.mocked(prisma.aiMessage.count).mockResolvedValue(1);
    vi.mocked(prisma.aiConversation.findMany).mockResolvedValue([
      {
        id: CONV_ID,
        title: null,
        userId: null,
        createdAt: new Date('2026-04-10'),
        messages: [{ role: 'user', content: 'hi' }],
      },
    ] as never);
    vi.mocked(prisma.aiConversation.count).mockResolvedValue(1);
    vi.mocked(prisma.aiConversation.groupBy).mockResolvedValue([] as never);
  });

  const functions = {
    getPopularTopics,
    getUnansweredQuestions,
    getEngagementMetrics,
    getContentGaps,
    getFeedbackSummary,
  };

  /** Every `where` handed to Prisma, tagged with the model it was for. */
  function wheres(): Array<{ model: 'conversation' | 'message'; where: Record<string, unknown> }> {
    const out: Array<{ model: 'conversation' | 'message'; where: Record<string, unknown> }> = [];
    for (const fn of [
      prisma.aiConversation.findMany,
      prisma.aiConversation.count,
      prisma.aiConversation.groupBy,
    ]) {
      for (const call of vi.mocked(fn).mock.calls) {
        out.push({
          model: 'conversation',
          where: (call[0] as { where: Record<string, unknown> }).where,
        });
      }
    }
    for (const fn of [prisma.aiMessage.findMany, prisma.aiMessage.count]) {
      for (const call of vi.mocked(fn).mock.calls) {
        out.push({
          model: 'message',
          where: (call[0] as { where: Record<string, unknown> }).where,
        });
      }
    }
    return out;
  }

  /** The conversation clause a read carries — its own `where` or its relation filter. */
  function conversationClause(entry: ReturnType<typeof wheres>[number]): Record<string, unknown> {
    return entry.model === 'conversation'
      ? entry.where
      : (entry.where.conversation as Record<string, unknown>);
  }

  // The read counts are pinned so a function that stopped issuing a query —
  // and so stopped being checked — is noticed rather than trivially green.
  const READS = {
    getPopularTopics: 1,
    getUnansweredQuestions: 2,
    getEngagementMetrics: 5,
    getContentGaps: 1,
    getFeedbackSummary: 5,
  } as const;

  for (const [name, fn] of Object.entries(functions) as Array<
    [keyof typeof functions, (typeof functions)[keyof typeof functions]]
  >) {
    it(`${name}: excludes ownerless conversations from every read when the policy refuses`, async () => {
      await fn({ ...baseQuery, agentId: 'cmjbv4i3x00003wsloputgwul' }, narrowedAdmin);

      const reads = wheres();
      expect(reads).toHaveLength(READS[name]);
      for (const read of reads) {
        const clause = conversationClause(read);
        expect(clause, JSON.stringify(read)).toMatchObject({
          userId: { not: null },
          // The agent filter survives beside it: the arm narrows, it does not replace.
          agentId: 'cmjbv4i3x00003wsloputgwul',
        });
      }
    });

    it(`${name}: names no owner on a default install, so the where is what it always was`, async () => {
      await fn(baseQuery, admin);

      const reads = wheres();
      expect(reads).toHaveLength(READS[name]);
      for (const read of reads) {
        // No `userId` key of any shape — not `{ not: null }`, not the caller's
        // id. The empty arm spread into the clause is the whole of the
        // default-install guarantee.
        expect(JSON.stringify(conversationClause(read) ?? {}), JSON.stringify(read)).not.toContain(
          'userId'
        );
      }
    });
  }

  it('the follow-up reads keyed on scoped ids carry the arm too', async () => {
    // Named separately from the loop because it is the case the loop would
    // pass without: the second query of `unanswered` and the fifth of
    // `feedback` are keyed on conversation ids the first query already
    // narrowed, so dropping the clause from them is safe today and invisible
    // to a test that only checked the first query. This pins the property the
    // service header states — every read, no carve-out.
    await getUnansweredQuestions(baseQuery, narrowedAdmin);
    const followUp = vi.mocked(prisma.aiMessage.findMany).mock.calls[1]?.[0];
    expect(followUp?.where).toMatchObject({
      conversationId: { in: ['cmjbv4i3x00003wsloputgwu9'] },
      conversation: { userId: { not: null } },
    });

    vi.clearAllMocks();
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([
      {
        id: 'msg-1',
        content: 'no',
        rating: -1,
        createdAt: new Date('2026-04-10'),
        ratedAt: new Date('2026-04-10'),
        conversationId: 'cmjbv4i3x00003wsloputgwu9',
        conversation: { agentId: 'agent-1', agent: { name: 'Agent' } },
      },
    ] as never);
    vi.mocked(prisma.aiMessage.count).mockResolvedValue(1);
    await getFeedbackSummary(baseQuery, narrowedAdmin);
    const negFollowUp = vi.mocked(prisma.aiMessage.findMany).mock.calls[2]?.[0];
    expect(negFollowUp?.where).toMatchObject({
      conversationId: { in: ['cmjbv4i3x00003wsloputgwu9'] },
      conversation: { userId: { not: null } },
    });
  });
});
