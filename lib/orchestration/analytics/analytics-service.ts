/**
 * Client Analytics Service
 *
 * Provides aggregated analytics for IP owners to understand how users
 * interact with their content via AI agents. All queries are scoped
 * by date range and optionally by agent.
 *
 * **Deployment-wide by design, and the policy still has a vote.** Every
 * function aggregates over every user's conversations — that is the product;
 * an admin's own threads would answer a different question — so none of them
 * takes the per-caller set `conversationVisibilityWhere` selects. What the
 * authorization policy decides is only whether this caller may read threads
 * nobody owns, and every read here applies exactly that arm through
 * `deploymentWideConversationWhere`: on a default install the clause is `{}`
 * and no number moves; under a policy that refuses the caller unattributed
 * reads, an inbound thread's messages leave every aggregate — `unanswered`
 * stops returning the sender's question verbatim — the same way the thread
 * leaves the list (t-694). Until then these reads consulted nothing, so a fork
 * that narrowed `canRead` and confirmed the thread 404d was still handing the
 * correspondence over here.
 *
 * The clause goes on **every** read, the follow-up queries keyed on ids from an
 * already-scoped result included. Those are safe by construction today, and
 * "every read carries it" is a property a test can assert without a carve-out
 * that the next edit to the first query would silently invalidate.
 *
 * Platform-agnostic: no Next.js imports (the session is a type). Requires Prisma.
 */

import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import type { AnalyticsQuery } from '@/lib/validations/orchestration';
import { deploymentWideConversationWhere } from '@/lib/orchestration/access/conversation-access';
import { resolveAnalyticsDateRange } from '@/lib/orchestration/analytics/date-range';

// ─── Shared Helpers ──────────────────────────────────────────────────────────

function resolveDateRange(query: AnalyticsQuery) {
  return resolveAnalyticsDateRange(query);
}

/**
 * The conversation clause every read composes: the optional agent filter and
 * the policy's ownerless arm. Spread rather than `AND`ed so that on a default
 * install — where the arm is `{}` — the `where` handed to Prisma is
 * byte-for-byte what it was before the arm existed; the two fragments' keys
 * (`agentId`, `userId`) cannot collide.
 */
function conversationScope(
  session: AuthenticatedSession,
  agentId?: string
): Prisma.AiConversationWhereInput {
  return {
    ...(agentId ? { agentId } : {}),
    ...deploymentWideConversationWhere(session),
  };
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
export async function getPopularTopics(
  query: AnalyticsQuery,
  session: AuthenticatedSession
): Promise<TopicEntry[]> {
  const { from, to } = resolveDateRange(query);
  const limit = query.limit ?? 20;

  const results = await prisma.aiMessage.findMany({
    where: {
      role: 'user',
      createdAt: { gte: from, lte: to },
      conversation: conversationScope(session, query.agentId),
    },
    select: { content: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 10_000,
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

const HEDGING_PHRASES = [
  "I don't know",
  "I'm not sure",
  "I don't have information",
  'I cannot find',
  'beyond my knowledge',
  "I'm unable to",
  'I do not have',
] as const;

export interface UnansweredEntry {
  messageId: string;
  conversationId: string;
  agentId: string;
  agentName: string | null;
  userMessage: string;
  assistantReply: string;
  matchedPhrase: string | null;
  createdAt: Date;
}

/**
 * Finds conversations where the assistant likely couldn't answer.
 * Heuristic: assistant responses containing hedging phrases like
 * "I don't know", "I'm not sure", "I don't have information", etc.
 *
 * Returns individual message pairs (user question + assistant reply).
 */
export async function getUnansweredQuestions(
  query: AnalyticsQuery,
  session: AuthenticatedSession
): Promise<UnansweredEntry[]> {
  const { from, to } = resolveDateRange(query);
  const limit = query.limit ?? 20;

  // Find assistant messages with hedging phrases
  const hedgingMessages = await prisma.aiMessage.findMany({
    where: {
      role: 'assistant',
      createdAt: { gte: from, lte: to },
      conversation: conversationScope(session, query.agentId),
      OR: HEDGING_PHRASES.map((phrase) => ({ content: { contains: phrase } })),
    },
    select: {
      id: true,
      content: true,
      createdAt: true,
      conversationId: true,
      conversation: {
        select: {
          agentId: true,
          agent: { select: { name: true } },
        },
      },
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
      conversation: conversationScope(session, query.agentId),
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
    const matchedPhrase = HEDGING_PHRASES.find((p) => msg.content.includes(p)) ?? null;
    return {
      messageId: msg.id,
      conversationId: msg.conversationId,
      agentId: msg.conversation.agentId,
      agentName: msg.conversation.agent?.name ?? null,
      userMessage: preceding?.content ?? '',
      assistantReply: msg.content.slice(0, 500),
      matchedPhrase,
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
export async function getEngagementMetrics(
  query: AnalyticsQuery,
  session: AuthenticatedSession
): Promise<EngagementMetrics> {
  const { from, to } = resolveDateRange(query);
  const scope = conversationScope(session, query.agentId);

  const [totalConversations, totalMessages, uniqueUsersResult, userConvCounts, conversations] =
    await Promise.all([
      // Total conversations in range
      prisma.aiConversation.count({
        where: { createdAt: { gte: from, lte: to }, ...scope },
      }),

      // Total messages in range (user + assistant)
      prisma.aiMessage.count({
        where: {
          createdAt: { gte: from, lte: to },
          conversation: scope,
        },
      }),

      // Unique users
      prisma.aiConversation.findMany({
        where: { createdAt: { gte: from, lte: to }, ...scope },
        select: { userId: true },
        distinct: ['userId'],
      }),

      // Returning users (users with >1 conversation in the period)
      prisma.aiConversation.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: from, lte: to }, ...scope },
        _count: { id: true },
        having: { id: { _count: { gt: 1 } } },
      }),

      // Daily conversation counts
      prisma.aiConversation.findMany({
        where: { createdAt: { gte: from, lte: to }, ...scope },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

  const uniqueUsers = uniqueUsersResult.length;

  // Average messages per conversation
  const avgMessagesPerConversation =
    totalConversations > 0 ? Math.round((totalMessages / totalConversations) * 10) / 10 : 0;

  const returningUsers = userConvCounts.length;
  const returningUserRate =
    uniqueUsers > 0 ? Math.round((returningUsers / uniqueUsers) * 1000) / 1000 : 0;

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
export async function getContentGaps(
  query: AnalyticsQuery,
  session: AuthenticatedSession
): Promise<ContentGap[]> {
  const { from, to } = resolveDateRange(query);
  const limit = query.limit ?? 20;
  const scope = conversationScope(session, query.agentId);

  // Get conversations with user activity in the date range
  const conversations = await prisma.aiConversation.findMany({
    where: {
      ...scope,
      messages: { some: { createdAt: { gte: from, lte: to }, role: 'user' } },
    },
    select: {
      id: true,
      title: true,
      messages: {
        select: { role: true, content: true },
        orderBy: { createdAt: 'asc' },
        take: 50,
      },
    },
    take: 500, // cap for performance
    orderBy: { updatedAt: 'desc' },
  });

  // Extract first user message as the "topic" and check if any assistant
  // message contains hedging language
  const topicStats = new Map<string, { display: string; total: number; unanswered: number }>();

  for (const conv of conversations) {
    const firstUserMsg = conv.messages.find((m) => m.role === 'user');
    if (!firstUserMsg) continue;

    // Use conversation title if available, otherwise truncate first user message
    const topic = conv.title ?? firstUserMsg.content.slice(0, 100);
    const topicKey = topic.toLowerCase().trim();

    const hasHedging = conv.messages.some(
      (m) => m.role === 'assistant' && HEDGING_PHRASES.some((p) => m.content.includes(p))
    );

    const existing = topicStats.get(topicKey) ?? { display: topic, total: 0, unanswered: 0 };
    existing.total++;
    if (hasHedging) existing.unanswered++;
    topicStats.set(topicKey, existing);
  }

  // Only include topics with at least 1 unanswered query, sorted by gap ratio
  const gaps: ContentGap[] = [];
  for (const [, stats] of topicStats) {
    if (stats.unanswered > 0) {
      gaps.push({
        topic: stats.display,
        queryCount: stats.total,
        unansweredCount: stats.unanswered,
        gapRatio: stats.unanswered / stats.total,
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
  satisfactionRate: number | null;
}

export interface FeedbackSummary {
  overall: {
    thumbsUp: number;
    thumbsDown: number;
    total: number;
    satisfactionRate: number | null;
  };
  byAgent: AgentFeedback[];
  recentNegative: Array<{
    messageId: string;
    conversationId: string;
    agentId: string;
    content: string;
    userMessage: string;
    ratedAt: Date;
  }>;
}

/**
 * Aggregates message ratings by agent and overall.
 * Also returns recent negatively-rated messages for review.
 */
export async function getFeedbackSummary(
  query: AnalyticsQuery,
  session: AuthenticatedSession
): Promise<FeedbackSummary> {
  const { from, to } = resolveDateRange(query);
  const scope = conversationScope(session, query.agentId);
  const limit = query.limit ?? 20;

  // Count ratings overall
  const [thumbsUp, thumbsDown] = await Promise.all([
    prisma.aiMessage.count({
      where: {
        rating: 1,
        ratedAt: { gte: from, lte: to },
        conversation: scope,
      },
    }),
    prisma.aiMessage.count({
      where: {
        rating: -1,
        ratedAt: { gte: from, lte: to },
        conversation: scope,
      },
    }),
  ]);

  const total = thumbsUp + thumbsDown;
  const satisfactionRate = total > 0 ? Math.round((thumbsUp / total) * 1000) / 1000 : null;

  // Per-agent breakdown
  const ratedMessages = await prisma.aiMessage.findMany({
    where: {
      rating: { not: null },
      ratedAt: { gte: from, lte: to },
      conversation: scope,
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
    take: 5_000,
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
      satisfactionRate: agentTotal > 0 ? Math.round((stats.up / agentTotal) * 1000) / 1000 : null,
    };
  });
  byAgent.sort((a, b) => b.total - a.total);

  // Recent negatively-rated messages
  const recentNegative = await prisma.aiMessage.findMany({
    where: {
      rating: -1,
      ratedAt: { gte: from, lte: to },
      conversation: scope,
    },
    select: {
      id: true,
      content: true,
      createdAt: true,
      ratedAt: true,
      conversationId: true,
      conversation: { select: { agentId: true } },
    },
    orderBy: { ratedAt: 'desc' },
    take: limit,
  });

  // Batch-fetch preceding user messages for negative feedback context
  const negConversationIds = [...new Set(recentNegative.map((m) => m.conversationId))];
  const negUserMessages =
    negConversationIds.length > 0
      ? await prisma.aiMessage.findMany({
          where: {
            conversationId: { in: negConversationIds },
            role: 'user',
            conversation: scope,
          },
          select: { conversationId: true, content: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        })
      : [];

  const negUserMsgsByConv = new Map<string, Array<{ content: string; createdAt: Date }>>();
  for (const um of negUserMessages) {
    const list = negUserMsgsByConv.get(um.conversationId) ?? [];
    list.push({ content: um.content, createdAt: um.createdAt });
    negUserMsgsByConv.set(um.conversationId, list);
  }

  return {
    overall: { thumbsUp, thumbsDown, total, satisfactionRate },
    byAgent,
    recentNegative: recentNegative.map((m) => {
      const convUserMsgs = negUserMsgsByConv.get(m.conversationId) ?? [];
      const preceding = convUserMsgs.find((um) => um.createdAt < m.createdAt);
      return {
        messageId: m.id,
        conversationId: m.conversationId,
        agentId: m.conversation.agentId,
        content: m.content.slice(0, 500),
        userMessage: preceding?.content ?? '',
        ratedAt: m.ratedAt ?? new Date(0),
      };
    }),
  };
}
