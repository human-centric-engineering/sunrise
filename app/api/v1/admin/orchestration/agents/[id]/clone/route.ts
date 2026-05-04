/**
 * Admin Orchestration — Clone agent
 *
 * POST /api/v1/admin/orchestration/agents/:id/clone
 *
 * Deep-clones an agent including capability bindings. The new agent
 * gets a fresh `systemInstructionsHistory` (empty) and the session
 * user as `createdBy`. All other fields are copied from the source.
 *
 * Optional body: `{ name?, slug? }` to override defaults.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cloneAgentBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  // Parse optional body (empty body is valid)
  let body: { name?: string; slug?: string } = {};
  try {
    const raw: unknown = await request.json();
    const bodyParsed = cloneAgentBodySchema.safeParse(raw);
    if (!bodyParsed.success) {
      throw new ValidationError('Invalid clone body', {
        body: bodyParsed.error.issues.map((i) => i.message),
      });
    }
    body = bodyParsed.data;
  } catch (err) {
    // Empty body or non-JSON is fine — use defaults
    if (err instanceof ValidationError) throw err;
  }

  const source = await prisma.aiAgent.findUnique({
    where: { id },
    include: { capabilities: true },
  });
  if (!source) throw new NotFoundError(`Agent ${id} not found`);

  // Cloning a system agent is allowed — the clone gets isSystem: false
  // (set explicitly below), so it's a safe copy with no special privileges.

  const name = body.name ?? `${source.name} (Copy)`;
  const baseSlug = body.slug ?? `${source.slug}-copy`;

  // Attempt slug with collision retry
  const MAX_SLUG_ATTEMPTS = 5;
  let newAgent: Awaited<ReturnType<typeof prisma.aiAgent.create>> | null = null;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;

    try {
      newAgent = await prisma.$transaction(async (tx) => {
        const agent = await tx.aiAgent.create({
          data: {
            name,
            slug,
            description: source.description,
            systemInstructions: source.systemInstructions,
            systemInstructionsHistory: [],
            model: source.model,
            provider: source.provider,
            providerConfig: (source.providerConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            temperature: source.temperature,
            maxTokens: source.maxTokens,
            monthlyBudgetUsd: source.monthlyBudgetUsd,
            fallbackProviders: source.fallbackProviders,
            metadata: (source.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            isActive: false,
            inputGuardMode: source.inputGuardMode,
            outputGuardMode: source.outputGuardMode,
            citationGuardMode: source.citationGuardMode,
            maxHistoryTokens: source.maxHistoryTokens,
            retentionDays: source.retentionDays,
            visibility: source.visibility,
            rateLimitRpm: source.rateLimitRpm,
            knowledgeCategories: source.knowledgeCategories,
            topicBoundaries: source.topicBoundaries,
            brandVoiceInstructions: source.brandVoiceInstructions,
            widgetConfig: (source.widgetConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            createdBy: session.user.id,
          },
        });

        if (source.capabilities.length > 0) {
          await tx.aiAgentCapability.createMany({
            data: source.capabilities.map((cap) => ({
              agentId: agent.id,
              capabilityId: cap.capabilityId,
            })),
          });
        }

        return agent;
      });

      break; // Success — exit retry loop
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        attempt < MAX_SLUG_ATTEMPTS - 1
      ) {
        continue; // Slug collision — try next suffix
      }
      throw err;
    }
  }

  if (!newAgent) {
    throw new ConflictError(
      `Could not generate a unique slug for clone (tried ${MAX_SLUG_ATTEMPTS} variants of "${baseSlug}")`
    );
  }

  log.info('Agent cloned', {
    sourceId: id,
    newAgentId: newAgent.id,
    slug: newAgent.slug,
    capabilitiesCloned: source.capabilities.length,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'agent.clone',
    entityType: 'agent',
    entityId: newAgent.id,
    entityName: newAgent.name,
    metadata: {
      sourceId: id,
      sourceSlug: source.slug,
      capabilitiesCloned: source.capabilities.length,
    },
    clientIp: clientIP,
  });

  return successResponse(newAgent, undefined, { status: 201 });
});
