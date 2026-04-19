/**
 * Tests for `lib/orchestration/analytics/analytics-service.ts`.
 *
 * Covers:
 *   - getPopularTopics: groupBy aggregation, date range, agent filter, limit
 *   - getUnansweredQuestions: hedging detection, user message lookup, empty results
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

// ─── Helpers ────────────────────────────────────────────────────────────────

const baseQuery = {
  from: '2026-04-01T00:00:00Z',
  to: '2026-04-19T00:00:00Z',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('getPopularTopics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns grouped topics sorted by count', async () => {
    vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([
      { content: 'How do I reset?', _count: { content: 5 }, _max: { createdAt: new Date() } },
      { content: 'What is pricing?', _count: { content: 3 }, _max: { createdAt: new Date() } },
    ] as never);

    const result = await getPopularTopics(baseQuery);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('How do I reset?');
    expect(result[0].count).toBe(5);
    expect(result[1].count).toBe(3);
  });

  it('returns empty array when no messages exist', async () => {
    vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([] as never);

    const result = await getPopularTopics(baseQuery);
    expect(result).toEqual([]);
  });

  it('respects limit parameter', async () => {
    vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([] as never);

    await getPopularTopics({ ...baseQuery, limit: 5 });

    expect(prisma.aiMessage.groupBy).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
  });

  it('filters by agentId when provided', async () => {
    vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([] as never);

    await getPopularTopics({ ...baseQuery, agentId: 'cmjbv4i3x00003wsloputgwul' });

    expect(prisma.aiMessage.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversation: expect.objectContaining({ agentId: 'cmjbv4i3x00003wsloputgwul' }),
        }),
      })
    );
  });

  it('defaults to 30-day range when no dates provided', async () => {
    vi.mocked(prisma.aiMessage.groupBy).mockResolvedValue([] as never);

    await getPopularTopics({});

    expect(prisma.aiMessage.groupBy).toHaveBeenCalledWith(
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
});

describe('getUnansweredQuestions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('finds hedging assistant messages and preceding user messages', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([
      {
        id: 'msg_1',
        content: "I don't know the answer to that question.",
        createdAt: new Date('2026-04-10T10:00:00Z'),
        conversationId: 'conv_1',
        conversation: { agentId: 'agent_1' },
      },
    ] as never);

    vi.mocked(prisma.aiMessage.findFirst).mockResolvedValue({
      content: 'What is the meaning of life?',
    } as never);

    const result = await getUnansweredQuestions(baseQuery);

    expect(result).toHaveLength(1);
    expect(result[0].userMessage).toBe('What is the meaning of life?');
    expect(result[0].assistantReply).toContain("I don't know");
    expect(result[0].conversationId).toBe('conv_1');
  });

  it('returns empty array when no hedging messages found', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    const result = await getUnansweredQuestions(baseQuery);
    expect(result).toEqual([]);
  });

  it('handles missing preceding user message', async () => {
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([
      {
        id: 'msg_1',
        content: "I'm not sure about that.",
        createdAt: new Date(),
        conversationId: 'conv_1',
        conversation: { agentId: 'agent_1' },
      },
    ] as never);

    vi.mocked(prisma.aiMessage.findFirst).mockResolvedValue(null);

    const result = await getUnansweredQuestions(baseQuery);

    expect(result[0].userMessage).toBe('(no preceding user message)');
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

    const result = await getEngagementMetrics(baseQuery);

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

    const result = await getEngagementMetrics(baseQuery);

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

    const result = await getContentGaps(baseQuery);

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

    const result = await getContentGaps(baseQuery);
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

    const result = await getContentGaps(baseQuery);

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

    const result = await getContentGaps(baseQuery);

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
        ratedAt: new Date(),
        conversationId: 'conv_1',
        conversation: { agentId: 'a1' },
      },
    ] as never);

    const result = await getFeedbackSummary(baseQuery);

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
  });

  it('returns zeros when no ratings exist', async () => {
    vi.mocked(prisma.aiMessage.count).mockResolvedValue(0);
    vi.mocked(prisma.aiMessage.findMany).mockResolvedValue([] as never);

    const result = await getFeedbackSummary(baseQuery);

    expect(result.overall.total).toBe(0);
    expect(result.overall.satisfactionRate).toBe(0);
    expect(result.byAgent).toEqual([]);
    expect(result.recentNegative).toEqual([]);
  });
});
