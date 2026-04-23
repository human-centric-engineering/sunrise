/**
 * Client Analytics Service
 *
 * Provides aggregated analytics for IP owners to understand how users
 * interact with their content via AI agents. All queries are scoped
 * by date range and optionally by agent.
 *
 * Platform-agnostic: no Next.js imports. Requires Prisma.
 */

import { prisma } from '@/lib/db/client';
import type { AnalyticsQuery } from '@/lib/validations/orchestration';
import { resolveAnalyticsDateRange } from '@/lib/orchestration/analytics/date-range';

// ─── Shared Helpers ──────────────────────────────────────────────────────────

function resolveDateRange(query: AnalyticsQuery) {
  return resolveAnalyticsDateRange(query);
}

function agentFilter(agentId?: string) {
  return agentId ? { agentId } : {};
}

// ─── Popular Topics ──────────────────────────────────────────────────────────

export interface TopicEntry {
  content: string;
  count: number;
  lastAsked: Date;
}

/**
 * Returns the most frequently asked user messages, grouped case-insensitively.
 * This gives IP owners a view of what users are asking about most.
 */
export async function getPopularTopics(query: AnalyticsQuery): Promise<TopicEntry[]> {
  const { from, to } = resolveDateRange(query);
  const limit = query.limit ?? 20;

  const results = await prisma.aiMessage.findMany({
    where: {
      role: 'user',
      createdAt: { gte: from, lte: to },
      conversation: { ...agentFilter(query.agentId) },
    },
    select: { content: true, createdAt: true },
  });

  // Group case-insensitively
  const grouped = new Map<string, { display: string; count: number; lastAsked: Date }>();
  for (const r of results) {
    const key = r.content.toLowerCase().trim();
    const existing = grouped.get(key);
    if (existing) {
      existing.count++;
      if (r.createdAt > existing.lastAsked) {
        existing.lastAsked = r.createdAt;
        existing.display = r.content; // keep most recent casing
      }
    } else {
      grouped.set(key, { display: r.content, count: 1, lastAsked: r.createdAt });
    }
  }

  // Sort by count descending and take limit
  const sorted = Array.from(grouped.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return sorted.map((g) => ({
    content: g.display,
    count: g.count,
    lastAsked: g.lastAsked,
  }));
}

// ─── Unanswered Questions ────────────────────────────────────────────────────

export interface UnansweredEntry {
  conversationId: string;
  agentId: string;
  userMessage: string;
  assistantReply: string;
  createdAt: Date;
}

/**
 * Finds conversations where the assistant likely couldn't answer.
 * Heuristic: assistant responses containing hedging phrases like
 * "I don't know", "I'm not sure", "I don't have information", etc.
 *
 * Returns individual message pairs (user question + assistant reply).
 */
export async function getUnansweredQuestions(query: AnalyticsQuery): Promise<UnansweredEntry[]> {
  const { from, to } = resolveDateRange(query);
  const limit = query.limit ?? 20;

  // Find assistant messages with hedging phrases
  const hedgingMessages = await prisma.aiMessage.findMany({
    where: {
      role: 'assistant',
      createdAt: { gte: from, lte: to },
      conversation: { ...agentFilter(query.agentId) },
      OR: [
        { content: { contains: "I don't know" } },
        { content: { contains: "I'm not sure" } },
        { content: { contains: "I don't have information" } },
        { content: { contains: 'I cannot find' } },
        { content: { contains: 'beyond my knowledge' } },
        { content: { contains: "I'm unable to" } },
        { content: { contains: 'I do not have' } },
      ],
    },
    select: {
      id: true,
      content: true,
      createdAt: true,
      conversationId: true,
      conversation: { select: { agentId: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // Batch-fetch preceding user messages for all hedging messages
  const conversationIds = [...new Set(hedgingMessages.map((m) => m.conversationId))];
  const userMessages = await prisma.aiMessage.findMany({
    where: {
      conversationId: { in: conversationIds },
      role: 'user',
    },
    select: { conversationId: true, content: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  // Index user messages by conversation for quick lookup
  const userMsgsByConv = new Map<string, Array<{ content: string; createdAt: Date }>>();
  for (const um of userMessages) {
    const list = userMsgsByConv.get(um.conversationId) ?? [];
    list.push({ content: um.content, createdAt: um.createdAt });
    userMsgsByConv.set(um.conversationId, list);
  }

  const entries: UnansweredEntry[] = hedgingMessages.map((msg) => {
    const convUserMsgs = userMsgsByConv.get(msg.conversationId) ?? [];
    // Find the latest user message before this hedging reply
    const preceding = convUserMsgs.find((um) => um.createdAt < msg.createdAt);
    return {
      conversationId: msg.conversationId,
      agentId: msg.conversation.agentId,
      userMessage: preceding?.content ?? '(no preceding user message)',
      assistantReply: msg.content.slice(0, 500),
      createdAt: msg.createdAt,
    };
  });

  return entries;
}

// ─── Engagement Metrics ──────────────────────────────────────────────────────

export interface EngagementMetrics {
  totalConversations: number;
  totalMessages: number;
  uniqueUsers: number;
  avgMessagesPerConversation: number;
  returningUsers: number;
  returningUserRate: number;
  conversationsByDay: Array<{ date: string; count: number }>;
}

/**
 * Computes engagement metrics: conversation count, unique users,
 * average depth, return rate, and daily conversation trend.
 */
export async function getEngagementMetrics(query: AnalyticsQuery): Promise<EngagementMetrics> {
  const { from, to } = resolveDateRange(query);
  const af = agentFilter(query.agentId);

  // Total conversations in range
  const totalConversations = await prisma.aiConversation.count({
    where: { createdAt: { gte: from, lte: to }, ...af },
  });

  // Total user messages in range
  const totalMessages = await prisma.aiMessage.count({
    where: {
      role: 'user',
      createdAt: { gte: from, lte: to },
      conversation: { ...af },
    },
  });

  // Unique users
  const uniqueUsersResult = await prisma.aiConversation.findMany({
    where: { createdAt: { gte: from, lte: to }, ...af },
    select: { userId: true },
    distinct: ['userId'],
  });
  const uniqueUsers = uniqueUsersResult.length;

  // Average messages per conversation
  const avgMessagesPerConversation =
    totalConversations > 0 ? Math.round((totalMessages / totalConversations) * 10) / 10 : 0;

  // Returning users (users with >1 conversation in the period)
  const userConvCounts = await prisma.aiConversation.groupBy({
    by: ['userId'],
    where: { createdAt: { gte: from, lte: to }, ...af },
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  });
  const returningUsers = userConvCounts.length;
  const returningUserRate =
    uniqueUsers > 0 ? Math.round((returningUsers / uniqueUsers) * 1000) / 1000 : 0;

  // Daily conversation counts
  const conversations = await prisma.aiConversation.findMany({
    where: { createdAt: { gte: from, lte: to }, ...af },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const dayMap = new Map<string, number>();
  for (const c of conversations) {
    const day = c.createdAt.toISOString().slice(0, 10);
    dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
  }
  const conversationsByDay = Array.from(dayMap.entries()).map(([date, count]) => ({
    date,
    count,
  }));

  return {
    totalConversations,
    totalMessages,
    uniqueUsers,
    avgMessagesPerConversation,
    returningUsers,
    returningUserRate,
    conversationsByDay,
  };
}

// ─── Content Gaps ────────────────────────────────────────────────────────────

export interface ContentGap {
  topic: string;
  queryCount: number;
  unansweredCount: number;
  gapRatio: number;
}

/**
 * Identifies topics where users ask frequently but the agent can't answer.
 * Uses a simplified word-frequency approach: extracts key terms from user
 * messages, then checks how many of those have hedging assistant replies.
 *
 * Returns topics sorted by gap ratio (high unanswered / total queries).
 */
export async function getContentGaps(query: AnalyticsQuery): Promise<ContentGap[]> {
  const { from, to } = resolveDateRange(query);
  const limit = query.limit ?? 20;
  const af = agentFilter(query.agentId);

  // Get conversations with their message counts and hedging counts
  const conversations = await prisma.aiConversation.findMany({
    where: { createdAt: { gte: from, lte: to }, ...af },
    select: {
      id: true,
      title: true,
      messages: {
        select: { role: true, content: true },
        orderBy: { createdAt: 'asc' },
        take: 10,
      },
    },
    take: 500, // cap for performance
    orderBy: { createdAt: 'desc' },
  });

  // Extract first user message as the "topic" and check if any assistant
  // message contains hedging language
  const topicStats = new Map<string, { total: number; unanswered: number }>();

  for (const conv of conversations) {
    const firstUserMsg = conv.messages.find((m) => m.role === 'user');
    if (!firstUserMsg) continue;

    // Use conversation title if available, otherwise truncate first user message
    const topic = conv.title ?? firstUserMsg.content.slice(0, 100);

    const hasHedging = conv.messages.some(
      (m) =>
        m.role === 'assistant' &&
        (m.content.includes("I don't know") ||
          m.content.includes("I'm not sure") ||
          m.content.includes("I don't have information") ||
          m.content.includes('I cannot find') ||
          m.content.includes('beyond my knowledge'))
    );

    const existing = topicStats.get(topic) ?? { total: 0, unanswered: 0 };
    existing.total++;
    if (hasHedging) existing.unanswered++;
    topicStats.set(topic, existing);
  }

  // Only include topics with at least 1 unanswered query, sorted by gap ratio
  const gaps: ContentGap[] = [];
  for (const [topic, stats] of topicStats) {
    if (stats.unanswered > 0) {
      gaps.push({
        topic,
        queryCount: stats.total,
        unansweredCount: stats.unanswered,
        gapRatio: Math.round((stats.unanswered / stats.total) * 100) / 100,
      });
    }
  }

  gaps.sort((a, b) => b.gapRatio - a.gapRatio || b.queryCount - a.queryCount);
  return gaps.slice(0, limit);
}

// ─── Feedback Summary ────────────────────────────────────────────────────────

export interface AgentFeedback {
  agentId: string;
  agentName: string;
  thumbsUp: number;
  thumbsDown: number;
  total: number;
  satisfactionRate: number;
}

export interface FeedbackSummary {
  overall: {
    thumbsUp: number;
    thumbsDown: number;
    total: number;
    satisfactionRate: number;
  };
  byAgent: AgentFeedback[];
  recentNegative: Array<{
    messageId: string;
    conversationId: string;
    agentId: string;
    content: string;
    ratedAt: Date;
  }>;
}

/**
 * Aggregates message ratings by agent and overall.
 * Also returns recent negatively-rated messages for review.
 */
export async function getFeedbackSummary(query: AnalyticsQuery): Promise<FeedbackSummary> {
  const { from, to } = resolveDateRange(query);
  const af = agentFilter(query.agentId);
  const limit = query.limit ?? 20;

  // Count ratings overall
  const [thumbsUp, thumbsDown] = await Promise.all([
    prisma.aiMessage.count({
      where: {
        rating: 1,
        ratedAt: { gte: from, lte: to },
        conversation: { ...af },
      },
    }),
    prisma.aiMessage.count({
      where: {
        rating: -1,
        ratedAt: { gte: from, lte: to },
        conversation: { ...af },
      },
    }),
  ]);

  const total = thumbsUp + thumbsDown;
  const satisfactionRate = total > 0 ? Math.round((thumbsUp / total) * 1000) / 1000 : 0;

  // Per-agent breakdown
  const ratedMessages = await prisma.aiMessage.findMany({
    where: {
      rating: { not: null },
      ratedAt: { gte: from, lte: to },
      conversation: { ...af },
    },
    select: {
      rating: true,
      conversation: {
        select: {
          agentId: true,
          agent: { select: { name: true } },
        },
      },
    },
  });

  const agentMap = new Map<string, { name: string; up: number; down: number }>();
  for (const msg of ratedMessages) {
    const aid = msg.conversation.agentId;
    const existing = agentMap.get(aid) ?? { name: msg.conversation.agent.name, up: 0, down: 0 };
    if (msg.rating === 1) existing.up++;
    else if (msg.rating === -1) existing.down++;
    agentMap.set(aid, existing);
  }

  const byAgent: AgentFeedback[] = Array.from(agentMap.entries()).map(([agentId, stats]) => {
    const agentTotal = stats.up + stats.down;
    return {
      agentId,
      agentName: stats.name,
      thumbsUp: stats.up,
      thumbsDown: stats.down,
      total: agentTotal,
      satisfactionRate: agentTotal > 0 ? Math.round((stats.up / agentTotal) * 1000) / 1000 : 0,
    };
  });
  byAgent.sort((a, b) => b.total - a.total);

  // Recent negatively-rated messages
  const recentNegative = await prisma.aiMessage.findMany({
    where: {
      rating: -1,
      ratedAt: { gte: from, lte: to },
      conversation: { ...af },
    },
    select: {
      id: true,
      content: true,
      ratedAt: true,
      conversationId: true,
      conversation: { select: { agentId: true } },
    },
    orderBy: { ratedAt: 'desc' },
    take: limit,
  });

  return {
    overall: { thumbsUp, thumbsDown, total, satisfactionRate },
    byAgent,
    recentNegative: recentNegative.map((m) => ({
      messageId: m.id,
      conversationId: m.conversationId,
      agentId: m.conversation.agentId,
      content: m.content.slice(0, 500),
      ratedAt: m.ratedAt!,
    })),
  };
}
