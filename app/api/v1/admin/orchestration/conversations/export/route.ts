/**
 * Admin Orchestration — Conversation Export
 *
 * GET /api/v1/admin/orchestration/conversations/export
 *
 * Exports the calling admin's own conversations with messages in JSON or
 * CSV format. Results are scoped to `session.user.id`, matching the list
 * endpoint. Supports the same filters as the list endpoint (agentId,
 * isActive, title/message search, tag, dateFrom, dateTo).
 *
 * Rate limited to 1 request per minute per admin to prevent abuse.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { csvEscape } from '@/lib/api/csv';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { conversationExportQuerySchema } from '@/lib/validations/orchestration';

/** Maximum conversations per export to prevent memory issues. */
const MAX_EXPORT_CONVERSATIONS = 500;

/** Maximum messages per conversation in exports to bound memory usage. */
const MAX_MESSAGES_PER_CONVERSATION = 500;

export const GET = withAdminAuth(async (request, session) => {
  // Extra rate limit for exports — 1/min per admin IP
  const ip = getClientIP(request);
  const rl = adminLimiter.check(`export:${ip}`);
  if (!rl.success) return createRateLimitResponse(rl);

  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const query = conversationExportQuerySchema.parse({
    format: searchParams.get('format') ?? undefined,
    agentId: searchParams.get('agentId') ?? undefined,
    isActive: searchParams.get('isActive') ?? undefined,
    q: searchParams.get('q') ?? undefined,
    messageSearch: searchParams.get('messageSearch') ?? undefined,
    tag: searchParams.get('tag') ?? undefined,
    dateFrom: searchParams.get('dateFrom') ?? undefined,
    dateTo: searchParams.get('dateTo') ?? undefined,
  });

  // Always scope to the caller — matches the list endpoint. Any incoming
  // `?userId=...` parameter is silently ignored.
  const where: Prisma.AiConversationWhereInput = { userId: session.user.id };
  if (query.agentId) where.agentId = query.agentId;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.q) where.title = { contains: query.q, mode: 'insensitive' };
  if (query.messageSearch) {
    where.messages = {
      some: { content: { contains: query.messageSearch, mode: 'insensitive' } },
    };
  }
  if (query.tag) where.tags = { has: query.tag };
  if (query.dateFrom || query.dateTo) {
    where.updatedAt = {
      ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
      ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
    };
  }

  const [conversations, totalConversations] = await Promise.all([
    prisma.aiConversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: MAX_EXPORT_CONVERSATIONS,
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: MAX_MESSAGES_PER_CONVERSATION,
        },
      },
    }),
    prisma.aiConversation.count({ where }),
  ]);

  log.info('Conversation export', {
    format: query.format,
    count: conversations.length,
  });

  if (query.format === 'csv') {
    const csvLines: string[] = [
      'conversation_id,conversation_title,agent_slug,user_id,message_role,message_content,created_at',
    ];

    for (const conv of conversations) {
      for (const msg of conv.messages) {
        csvLines.push(
          [
            csvEscape(conv.id),
            csvEscape(conv.title ?? ''),
            csvEscape(conv.agent?.slug ?? ''),
            csvEscape(conv.userId),
            csvEscape(msg.role),
            csvEscape(msg.content),
            csvEscape(msg.createdAt.toISOString()),
          ].join(',')
        );
      }
    }

    return new Response(csvLines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="conversations-export-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  // JSON format
  const data = conversations.map((conv) => ({
    id: conv.id,
    title: conv.title,
    userId: conv.userId,
    agentId: conv.agentId,
    agentSlug: conv.agent?.slug ?? null,
    agentName: conv.agent?.name ?? null,
    isActive: conv.isActive,
    createdAt: conv.createdAt.toISOString(),
    updatedAt: conv.updatedAt.toISOString(),
    messages: conv.messages.map((msg) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      metadata: msg.metadata,
      createdAt: msg.createdAt.toISOString(),
    })),
  }));

  const capped = totalConversations > MAX_EXPORT_CONVERSATIONS;
  const meta = { total: data.length, totalMatching: totalConversations, capped };
  return new Response(JSON.stringify({ success: true, data, meta }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="conversations-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});
