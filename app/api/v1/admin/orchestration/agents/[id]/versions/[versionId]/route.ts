/**
 * Admin Orchestration — Agent Version Detail / Restore
 *
 * GET  /api/v1/admin/orchestration/agents/:id/versions/:versionId
 *   - Returns the full version snapshot (including config at that point).
 *
 * POST /api/v1/admin/orchestration/agents/:id/versions/:versionId
 *   - Restores the agent to this version's snapshot.
 *   - Creates a new version entry ("Restored from v{N}").
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { z } from 'zod';

const agentSnapshotSchema = z.object({
  systemInstructions: z.string().nullable(),
  model: z.string(),
  provider: z.string(),
  fallbackProviders: z.array(z.string()).default([]),
  temperature: z.number().nullable(),
  maxTokens: z.number().nullable(),
  topicBoundaries: z.array(z.string()).default([]),
  brandVoiceInstructions: z.string().nullable().default(null),
  metadata: z.unknown().default(null),
  knowledgeCategories: z.array(z.string()).default([]),
  rateLimitRpm: z.number().nullable().default(null),
  visibility: z.string().default('internal'),
});

function validateIds(rawAgentId: string, rawVersionId: string) {
  const agentParsed = cuidSchema.safeParse(rawAgentId);
  if (!agentParsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  const versionParsed = cuidSchema.safeParse(rawVersionId);
  if (!versionParsed.success) {
    throw new ValidationError('Invalid version id', { versionId: ['Must be a valid CUID'] });
  }
  return { agentId: agentParsed.data, versionId: versionParsed.data };
}

export const GET = withAdminAuth<{ id: string; versionId: string }>(
  async (_request, _session, { params }) => {
    const { id: rawId, versionId: rawVersionId } = await params;
    const { agentId, versionId } = validateIds(rawId, rawVersionId);

    const version = await prisma.aiAgentVersion.findFirst({
      where: { id: versionId, agentId },
    });
    if (!version) throw new NotFoundError('Version not found');

    return successResponse(version);
  }
);

export const POST = withAdminAuth<{ id: string; versionId: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);
    const rateLimit = adminLimiter.check(clientIP);
    if (!rateLimit.success) return createRateLimitResponse(rateLimit);

    const log = await getRouteLogger(request);
    const { id: rawId, versionId: rawVersionId } = await params;
    const { agentId, versionId } = validateIds(rawId, rawVersionId);

    const [agent, version] = await Promise.all([
      prisma.aiAgent.findUnique({ where: { id: agentId } }),
      prisma.aiAgentVersion.findFirst({ where: { id: versionId, agentId } }),
    ]);
    if (!agent) throw new NotFoundError(`Agent ${agentId} not found`);
    if (!version) throw new NotFoundError('Version not found');

    const snapshotResult = agentSnapshotSchema.safeParse(version.snapshot);
    if (!snapshotResult.success) {
      throw new ValidationError('Version snapshot is malformed and cannot be restored', {
        snapshot: snapshotResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const snapshot = snapshotResult.data;

    // Get next version number for the restore entry
    const lastVersion = await prisma.aiAgentVersion.findFirst({
      where: { agentId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (lastVersion?.version ?? 0) + 1;

    // Snapshot the current state before restoring (so the current config isn't lost)
    const currentSnapshot = {
      systemInstructions: agent.systemInstructions,
      model: agent.model,
      provider: agent.provider,
      fallbackProviders: agent.fallbackProviders,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      topicBoundaries: agent.topicBoundaries,
      brandVoiceInstructions: agent.brandVoiceInstructions,
      metadata: agent.metadata,
      knowledgeCategories: agent.knowledgeCategories,
      rateLimitRpm: agent.rateLimitRpm,
      visibility: agent.visibility,
    };

    // Apply the snapshot fields back to the agent and create a restore version
    await prisma.$transaction([
      prisma.aiAgentVersion.create({
        data: {
          agentId,
          version: nextVersion,
          snapshot: currentSnapshot as unknown as Prisma.InputJsonValue,
          changeSummary: `Restored from v${version.version}`,
          createdBy: session.user.id,
        },
      }),
      prisma.aiAgent.update({
        where: { id: agentId },
        data: {
          systemInstructions: snapshot.systemInstructions ?? undefined,
          model: snapshot.model,
          provider: snapshot.provider,
          fallbackProviders: snapshot.fallbackProviders,
          temperature: snapshot.temperature ?? undefined,
          maxTokens: snapshot.maxTokens ?? undefined,
          topicBoundaries: snapshot.topicBoundaries,
          brandVoiceInstructions: snapshot.brandVoiceInstructions,
          knowledgeCategories: snapshot.knowledgeCategories,
          rateLimitRpm: snapshot.rateLimitRpm,
          visibility: snapshot.visibility,
        },
      }),
    ]);

    const updatedAgent = await prisma.aiAgent.findUnique({ where: { id: agentId } });

    log.info('Agent restored from version', {
      agentId,
      restoredFromVersion: version.version,
      newVersion: nextVersion,
      adminId: session.user.id,
    });

    return successResponse({
      agent: updatedAgent,
      restoredFromVersion: version.version,
      newVersion: nextVersion,
    });
  }
);
