/**
 * Admin Orchestration — Conversation Export
 *
 * GET /api/v1/admin/orchestration/conversations/export
 *
 * Exports conversations with messages in JSON or CSV format.
 * Supports the same filters as the list endpoint (agentId, userId,
 * dateFrom, dateTo). Streamed response for large exports.
 *
 * Rate limited to 1 request per minute per admin to prevent abuse.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { conversationExportQuerySchema } from '@/lib/validations/orchestration';

/** Maximum conversations per export to prevent memory issues. */
const MAX_EXPORT_CONVERSATIONS = 500;

export const GET = withAdminAuth(async (request, _session) => {
  // Extra rate limit for exports — 1/min per admin IP
  const ip = getClientIP(request);
  const rl = adminLimiter.check(`export:${ip}`);
  if (!rl.success) return createRateLimitResponse(rl);

  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const query = conversationExportQuerySchema.parse({
    format: searchParams.get('format') ?? undefined,
    agentId: searchParams.get('agentId') ?? undefined,
    userId: searchParams.get('userId') ?? undefined,
    dateFrom: searchParams.get('dateFrom') ?? undefined,
    dateTo: searchParams.get('dateTo') ?? undefined,
  });

  const where: Prisma.AiConversationWhereInput = {};
  if (query.userId) where.userId = query.userId;
  if (query.agentId) where.agentId = query.agentId;
  if (query.dateFrom || query.dateTo) {
    where.updatedAt = {
      ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
      ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
    };
  }

  const conversations = await prisma.aiConversation.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: MAX_EXPORT_CONVERSATIONS,
    include: {
      agent: { select: { id: true, name: true, slug: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

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

  return new Response(JSON.stringify({ success: true, data, meta: { total: data.length } }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="conversations-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});

/** Escape a value for CSV — wraps in double quotes and escapes internal quotes. */
function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
