/**
 * Admin Orchestration — Conversation provenance (Markdown)
 *
 * GET /api/v1/admin/orchestration/conversations/:id/provenance.md
 *
 * Returns a deterministic Markdown rendering of the conversation's
 * per-message provenance bundle. Mirrors the sibling
 * `executions/:id/report.md` route — same Content-Type, same
 * Content-Disposition pattern, same `no-store` cache directive.
 *
 * The renderer (`renderConversationMarkdown`) is platform-agnostic and
 * emits HTML-ready GitHub-flavoured Markdown so a future Gotenberg PDF
 * adapter can convert without surprises.
 *
 * Ownership: rows are scoped to `session.user.id`. Cross-user access
 * returns 404.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { messageProvenanceSchema } from '@/lib/validations/orchestration';
import {
  renderConversationMarkdown,
  type RenderConversationMessage,
} from '@/lib/orchestration/trace/render-conversation-markdown';

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid conversation id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const conversation = await prisma.aiConversation.findUnique({
    where: { id },
    include: {
      agent: { select: { id: true, slug: true, name: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!conversation || conversation.userId !== session.user.id) {
    throw new NotFoundError(`Conversation ${id} not found`);
  }

  const messages: RenderConversationMessage[] = conversation.messages.map((msg) => {
    let provenance = null;
    if (msg.provenance !== null) {
      const result = messageProvenanceSchema.safeParse(msg.provenance);
      if (result.success) {
        provenance = result.data;
      } else {
        log.warn('Provenance JSON failed validation, omitting from rendered bundle', {
          conversationId: id,
          messageId: msg.id,
          issues: result.error.issues.length,
        });
      }
    }
    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      capabilitySlug: msg.capabilitySlug,
      createdAt: msg.createdAt.toISOString(),
      agentVersionId: msg.agentVersionId,
      workflowExecutionId: msg.workflowExecutionId,
      workflowVersionId: msg.workflowVersionId,
      modelId: msg.modelId,
      providerSlug: msg.providerSlug,
      provenance,
    };
  });

  const markdown = renderConversationMarkdown(
    {
      id: conversation.id,
      title: conversation.title,
      userId: conversation.userId,
      agentId: conversation.agentId,
      agentSlug: conversation.agent?.slug ?? null,
      agentName: conversation.agent?.name ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      isActive: conversation.isActive,
    },
    messages
  );

  log.info('Conversation provenance markdown rendered', {
    conversationId: id,
    messageCount: messages.length,
    bytes: markdown.length,
  });

  return new Response(markdown, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="conversation-${id}-provenance.md"`,
      'Cache-Control': 'no-store',
    },
  });
});
