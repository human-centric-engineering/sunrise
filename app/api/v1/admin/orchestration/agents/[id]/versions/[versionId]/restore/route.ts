/**
 * Admin Orchestration — Restore Agent Version
 *
 * POST /api/v1/admin/orchestration/agents/:id/versions/:versionId/restore
 *
 * Restores an agent to a previous version snapshot. Applies the
 * snapshot fields to the agent and creates a new version entry
 * recording the restore action.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

const versionSnapshotSchema = z.object({
  systemInstructions: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  fallbackProviders: z.array(z.string()).optional(),
  temperature: z.number().nullable().optional(),
  maxTokens: z.number().int().nullable().optional(),
  topicBoundaries: z.array(z.string()).optional(),
  brandVoiceInstructions: z.string().nullable().optional(),
  metadata: z.unknown().optional(),
  knowledgeCategories: z.array(z.string()).optional(),
  rateLimitRpm: z.number().int().nullable().optional(),
  visibility: z.enum(['internal', 'public', 'invite_only']).optional(),
});

export const POST = withAdminAuth<{ id: string; versionId: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);
    const rateLimit = adminLimiter.check(clientIP);
    if (!rateLimit.success) return createRateLimitResponse(rateLimit);

    const log = await getRouteLogger(request);
    const { id: rawId, versionId: rawVersionId } = await params;

    const parsedId = cuidSchema.safeParse(rawId);
    if (!parsedId.success)
      throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
    const id = parsedId.data;

    const parsedVersionId = cuidSchema.safeParse(rawVersionId);
    if (!parsedVersionId.success)
      throw new ValidationError('Invalid version id', { versionId: ['Must be a valid CUID'] });
    const versionId = parsedVersionId.data;

    const agent = await prisma.aiAgent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundError(`Agent ${id} not found`);

    const version = await prisma.aiAgentVersion.findFirst({
      where: { id: versionId, agentId: id },
    });
    if (!version) throw new NotFoundError(`Version ${versionId} not found for agent ${id}`);

    const parsed = versionSnapshotSchema.safeParse(version.snapshot);
    if (!parsed.success) {
      throw new ValidationError('Invalid version snapshot data', {
        snapshot: parsed.error.issues.map((i) => i.message),
      });
    }
    const snapshot = parsed.data;

    // Build the update data from the snapshot — only apply fields that exist
    const updateData: Prisma.AiAgentUncheckedUpdateInput = {};
    if (snapshot.systemInstructions !== undefined)
      updateData.systemInstructions = snapshot.systemInstructions;
    if (snapshot.model !== undefined) updateData.model = snapshot.model;
    if (snapshot.provider !== undefined) updateData.provider = snapshot.provider;
    if (snapshot.fallbackProviders !== undefined)
      updateData.fallbackProviders = snapshot.fallbackProviders;
    if (snapshot.temperature !== undefined && snapshot.temperature !== null)
      updateData.temperature = snapshot.temperature;
    if (snapshot.maxTokens !== undefined && snapshot.maxTokens !== null)
      updateData.maxTokens = snapshot.maxTokens;
    if (snapshot.topicBoundaries !== undefined)
      updateData.topicBoundaries = snapshot.topicBoundaries;
    if (snapshot.brandVoiceInstructions !== undefined)
      updateData.brandVoiceInstructions = snapshot.brandVoiceInstructions;
    if (snapshot.knowledgeCategories !== undefined)
      updateData.knowledgeCategories = snapshot.knowledgeCategories;
    if (snapshot.rateLimitRpm !== undefined) updateData.rateLimitRpm = snapshot.rateLimitRpm;
    if (snapshot.visibility !== undefined) updateData.visibility = snapshot.visibility;
    if (snapshot.metadata !== undefined)
      updateData.metadata = snapshot.metadata as Prisma.InputJsonValue;

    // Wrap in a transaction to prevent race conditions on version numbering
    const { updated, nextVersion } = await prisma.$transaction(async (tx) => {
      const txUpdated = await tx.aiAgent.update({ where: { id }, data: updateData });

      const lastVersion = await tx.aiAgentVersion.findFirst({
        where: { agentId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const txNextVersion = (lastVersion?.version ?? 0) + 1;

      await tx.aiAgentVersion.create({
        data: {
          agentId: id,
          version: txNextVersion,
          snapshot: version.snapshot as Prisma.InputJsonValue,
          changeSummary: `Restored from version ${version.version}`,
          createdBy: session.user.id,
        },
      });

      return { updated: txUpdated, nextVersion: txNextVersion };
    });

    log.info('Agent restored from version', {
      agentId: id,
      restoredFromVersion: version.version,
      newVersion: nextVersion,
    });

    return successResponse({
      agent: updated,
      restoredFromVersion: version.version,
      newVersion: nextVersion,
    });
  }
);
