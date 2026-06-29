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
import { getClientIP } from '@/lib/security/ip';
import { cloneAgentBodySchema } from '@/lib/validations/orchestration';
import { cloneCopiedScalarFields } from '@/lib/orchestration/agents/agent-field-registry';
import {
  INITIAL_VERSION_SUMMARY,
  asSnapshotJson,
  buildAgentSnapshot,
} from '@/lib/orchestration/agents/agent-versioning';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

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
    include: {
      capabilities: true,
      grantedTags: { select: { tagId: true } },
      grantedDocuments: { select: { documentId: true } },
    },
  });
  if (!source || source.deletedAt !== null) throw new NotFoundError(`Agent ${id} not found`);

  const sourceTagIds = (source.grantedTags ?? []).map((g) => g.tagId);
  const sourceDocumentIds = (source.grantedDocuments ?? []).map((g) => g.documentId);

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
        // Fields the clone sets explicitly: fresh name/slug, reset active flag
        // and history, new owner. Every other scalar is copied from the source
        // via the registry, so a new agent field is cloned automatically.
        const cloneData: Record<string, unknown> = {
          name,
          slug,
          isActive: false,
          systemInstructionsHistory: [],
          createdBy: session.user.id,
        };
        const sourceRecord = source as unknown as Record<string, unknown>;
        for (const { name: field, json } of cloneCopiedScalarFields()) {
          cloneData[field] = json ? (sourceRecord[field] ?? Prisma.JsonNull) : sourceRecord[field];
        }
        const agent = await tx.aiAgent.create({
          data: cloneData as Prisma.AiAgentUncheckedCreateInput,
        });

        if (source.capabilities.length > 0) {
          await tx.aiAgentCapability.createMany({
            data: source.capabilities.map((cap) => ({
              agentId: agent.id,
              capabilityId: cap.capabilityId,
              isEnabled: cap.isEnabled,
              customConfig: (cap.customConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
              customRateLimit: cap.customRateLimit,
            })),
          });
        }

        // Carry over the source's knowledge-access grants so the clone is
        // immediately usable with the same scope. If the operator wants
        // different grants they can edit the clone afterwards.
        if (sourceTagIds.length > 0) {
          await tx.aiAgentKnowledgeTag.createMany({
            data: sourceTagIds.map((tagId) => ({ agentId: agent.id, tagId })),
            skipDuplicates: true,
          });
        }
        if (sourceDocumentIds.length > 0) {
          await tx.aiAgentKnowledgeDocument.createMany({
            data: sourceDocumentIds.map((documentId) => ({ agentId: agent.id, documentId })),
            skipDuplicates: true,
          });
        }

        // Point-in-time versioning: capture the clone's starting config as its
        // own v1 ("Initial configuration"), incl. the carried-over grants, so it
        // has a restorable original like any freshly-created agent.
        await tx.aiAgentVersion.create({
          data: {
            agentId: agent.id,
            version: 1,
            snapshot: asSnapshotJson(
              buildAgentSnapshot(agent, {
                grantedTagIds: sourceTagIds,
                grantedDocumentIds: sourceDocumentIds,
              })
            ),
            changeSummary: INITIAL_VERSION_SUMMARY,
            createdBy: session.user.id,
          },
        });

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
