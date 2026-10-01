/**
 * Admin Orchestration — Refine section with agent (LLM rewrite without chat)
 *
 *   POST /api/v1/admin/orchestration/knowledge/documents/:id/cleanup/section/refine
 *
 * Body: { sectionId: string, instructions: string }
 *
 * Calls the cleanup agent's LLM with the addressed section + instructions and
 * emits a pending change for the admin to Accept or Reject — same contract
 * as `rewrite_section_with_llm` from chat, but invoked directly from the
 * inline section editor without needing a chat round-trip.
 *
 * Looks up the cleanup conversation for this doc via contextType +
 * contextId, then loads that conversation's bound agent for provider/model.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { logger } from '@/lib/logging';
import { estimateTokens } from '@/lib/orchestration/chat/token-estimator';
import { getEditLockState } from '@/lib/orchestration/knowledge/edit-lock';
import { detectSections } from '@/lib/orchestration/knowledge/section-detection';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { primaryCallContext } from '@/lib/orchestration/llm/provider-eligibility';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { cleanupRefineLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { cuidSchema } from '@/lib/validations/common';

const bodySchema = z.object({
  sectionId: z.string().min(1).max(64),
  instructions: z.string().min(1).max(2000),
});

const SYSTEM_PROMPT = `You are a document cleanup assistant. You will be given ONE section of a document and instructions for how to clean it up. Apply the instructions faithfully and return ONLY the cleaned section — no preamble, no commentary, no markdown code fences. Do not add or restate the section heading; just return the cleaned body text.`;

const LEADING_HEADING = /^(#{1,6}\s+.+?)\r?\n/;

// Reserved for the model's response. The guard rejects requests where the
// estimated prompt size would leave less than this for output.
const RESPONSE_TOKEN_BUDGET = 4_096;
// Fallback context window when the model isn't in the registry — modern
// frontier minimum. Conservative: under-reports rather than over-promises.
const FALLBACK_CONTEXT_WINDOW = 128_000;

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  const { id: rawId } = await params;
  const parsedId = cuidSchema.safeParse(rawId);
  if (!parsedId.success) {
    throw new ValidationError('Invalid document id', { id: ['Must be a valid CUID'] });
  }
  const documentId = parsedId.data;

  // Per-flow sub-cap — this route calls the LLM provider directly rather
  // than through the capability dispatcher, so it doesn't otherwise inherit
  // any per-call limit (see cleanupRefineLimiter for the parity rationale).
  const rateLimit = cleanupRefineLimiter.check(`cleanup-refine:user:${session.user.id}`);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const body = await validateRequestBody(request, bodySchema);

  // Lock check (same admin's lock is fine; another admin blocks).
  const lockState = await getEditLockState(documentId);
  if (lockState.active && lockState.heldBy !== session.user.id) {
    return errorResponse('Document is being edited by another admin', {
      code: 'LOCK_HELD',
      status: 423,
      details: { heldBy: [lockState.heldBy ?? 'unknown'] },
    });
  }

  const doc = await prisma.aiKnowledgeDocument.findFirst({
    where: { id: documentId, uploadedBy: session.user.id, status: 'cleaning' },
    select: { processedContent: true, originalContent: true },
  });
  if (!doc) {
    throw new ValidationError(
      'Document not found, not owned by this user, or not in cleaning status'
    );
  }

  // Resolve the cleanup conversation for this doc → its agent's provider/model.
  const conv = await prisma.aiConversation.findFirst({
    where: { contextType: 'knowledge_document', contextId: documentId },
    orderBy: { createdAt: 'desc' },
    select: { agentId: true },
  });
  if (!conv) {
    throw new ValidationError('No cleanup conversation found for this document');
  }
  const agent = await prisma.aiAgent.findUnique({
    where: { id: conv.agentId },
    select: { provider: true, model: true, temperature: true, fallbackProviders: true },
  });
  if (!agent) {
    return errorResponse('Cleanup agent not found', {
      code: 'AGENT_MISCONFIGURED',
      status: 500,
    });
  }
  // Resolve through the same seam the chat loop uses. The cleanup agent is
  // seeded with provider/model EMPTY so it inherits the install's binding;
  // reading the row directly made this route return 500 on every default
  // install. See lib/orchestration/llm/agent-resolver.ts.
  let binding;
  try {
    binding = await resolveAgentProviderAndModel(agent, 'chat');
  } catch (err) {
    log.error('cleanup-refine: no usable provider binding', {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('No LLM provider is configured for this install', {
      code: 'AGENT_MISCONFIGURED',
      status: 500,
    });
  }

  const currentContent = doc.processedContent ?? doc.originalContent ?? '';
  const sections = detectSections(currentContent);
  // By id, never by marker — markers are labels and repeat within a doc, so
  // a marker lookup would propose a rewrite of the wrong section's body.
  const section = sections.find((s) => s.id === body.sectionId) ?? null;
  if (!section) {
    return errorResponse('Section not found', {
      code: 'SECTION_NOT_FOUND',
      status: 404,
      details: { sectionId: [body.sectionId] },
    });
  }

  // Separate any leading markdown heading so it round-trips verbatim — same
  // contract as rewrite_section_with_llm.
  const headingMatch = section.body.match(LEADING_HEADING);
  const headingLine = headingMatch?.[1] ?? null;
  const bodyAfter = headingMatch ? section.body.slice(headingMatch[0].length) : section.body;
  const headingForPrompt = headingLine ?? `(section: ${section.marker})`;

  // Pre-flight token check — refuse sections that wouldn't leave room for a
  // response. Catches the case where a single section in a book-sized doc
  // exceeds the model's context window.
  const userMessage = `INSTRUCTIONS:\n${body.instructions}\n\n---\nSECTION HEADING:\n${headingForPrompt}\n\nSECTION BODY:\n${bodyAfter}`;
  const promptTokens =
    estimateTokens(SYSTEM_PROMPT, binding.model) + estimateTokens(userMessage, binding.model);
  const modelInfo = getModel(binding.model);
  const contextWindow = modelInfo?.maxContext ?? FALLBACK_CONTEXT_WINDOW;
  if (promptTokens + RESPONSE_TOKEN_BUDGET > contextWindow) {
    return errorResponse('Section is too large to refine with the current model', {
      code: 'SECTION_TOO_LARGE',
      status: 413,
      details: {
        promptTokens: [String(promptTokens)],
        contextWindow: [String(contextWindow)],
        responseBudget: [String(RESPONSE_TOKEN_BUDGET)],
        suggestion: [
          'Split this section into smaller pieces or use a model with a larger context window',
        ],
      },
    });
  }

  let provider;
  try {
    provider = await getProvider(binding.providerSlug, primaryCallContext(binding.provenance));
  } catch (err) {
    logger.error('cleanup-refine: provider load failed', { err, slug: binding.providerSlug });
    return errorResponse(`Provider "${binding.providerSlug}" unavailable`, {
      code: 'PROVIDER_UNAVAILABLE',
      status: 502,
    });
  }

  const response = await provider.chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    { model: binding.model, temperature: agent.temperature ?? 0.2 }
  );

  const rewritten = response.content.trim();
  if (rewritten.length === 0) {
    return errorResponse('LLM returned empty content', {
      code: 'EMPTY_RESPONSE',
      status: 502,
    });
  }

  const trailingNewline = section.body.endsWith('\n') ? '\n' : '';
  const newSectionBody = headingLine
    ? `${headingLine}\n${rewritten}${trailingNewline}`
    : `${rewritten}${trailingNewline}`;
  const after =
    currentContent.slice(0, section.startOffset) +
    newSectionBody +
    currentContent.slice(section.endOffset);

  const pending = await prisma.aiKnowledgeDocumentPendingChange.create({
    data: {
      documentId,
      source: 'rewrite_section_with_llm',
      beforeContent: currentContent,
      afterContent: after,
      sectionMarker: section.marker,
      instructions: body.instructions,
      actorId: session.user.id,
    },
  });

  log.info('Cleanup section refine emitted pending change', {
    documentId,
    pendingChangeId: pending.id,
    sectionId: section.id,
    sectionMarker: section.marker,
    adminId: session.user.id,
  });

  return successResponse({
    pendingChangeId: pending.id,
    sectionId: section.id,
    sectionMarker: section.marker,
    summary: {
      charsBefore: currentContent.length,
      charsAfter: after.length,
      deltaPct:
        currentContent.length === 0
          ? 0
          : ((after.length - currentContent.length) / currentContent.length) * 100,
    },
  });
});
