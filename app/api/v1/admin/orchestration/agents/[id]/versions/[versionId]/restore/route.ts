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
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { logger } from '@/lib/logging';
import {
  systemInstructionsHistorySchema,
  updateAgentObjectSchema,
  type SystemInstructionsHistoryEntry,
} from '@/lib/validations/orchestration';
import { versionedScalarFieldNames } from '@/lib/orchestration/agents/agent-field-registry';

/**
 * A version snapshot is validated against the same per-field rules a PATCH uses
 * (`updateAgentObjectSchema`) — every versioned field is an optional field
 * there, so enum/bound validation is preserved and a snapshot can never restore
 * an invalid value into a plain `String` column. Unknown keys (e.g. the
 * long-dropped `knowledgeCategories`) are stripped; absent fields are skipped on
 * apply. Which fields are written back is the registry's job
 * (`versionedScalarFieldNames()`), so restore covers the full versioned config
 * by construction.
 *
 * `metadata` / `providerConfig` are relaxed to opaque optionals: they're
 * arbitrary JSON the DB may hold as `null`, which the PATCH schema (built for
 * user input) doesn't accept. A stored snapshot only needs them to round-trip —
 * they were validated when first written — so we don't re-validate their shape.
 */
const versionSnapshotSchema = updateAgentObjectSchema.extend({
  metadata: z.unknown().optional(),
  providerConfig: z.unknown().optional(),
});

export const POST = withAdminAuth<{ id: string; versionId: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

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

    if (agent.isSystem) {
      throw new ForbiddenError('Cannot restore versions on system agents');
    }

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

    const updateData: Record<string, unknown> = {};

    // systemInstructions is restored with history tracking: push the current
    // value onto the history column (same pattern as the PATCH route) before
    // overwriting. Handled out of the generic loop because of that extra write.
    if (snapshot.systemInstructions !== undefined) {
      if (snapshot.systemInstructions !== agent.systemInstructions) {
        const historyParse = systemInstructionsHistorySchema.safeParse(
          agent.systemInstructionsHistory
        );
        if (!historyParse.success) {
          logger.warn('Restore: systemInstructionsHistory malformed, resetting', {
            agentId: id,
            issues: historyParse.error.issues,
          });
        }
        const history: SystemInstructionsHistoryEntry[] = historyParse.success
          ? historyParse.data
          : [];
        history.push({
          instructions: agent.systemInstructions,
          changedAt: new Date().toISOString(),
          changedBy: session.user.id,
        });
        updateData.systemInstructions = snapshot.systemInstructions;
        updateData.systemInstructionsHistory = history;
      } else {
        updateData.systemInstructions = snapshot.systemInstructions;
      }
    }

    // Apply every versioned scalar field present in the snapshot. The set is
    // registry-derived, so restore covers the full versioned config by
    // construction — no field can be silently omitted the way the old
    // hand-maintained apply-list dropped persona/guardrails/modes and the
    // knowledge/runtime-prompt fields. Grant relations are versioned but aren't
    // columns, so they're not restored here (tracked for the #330 restore work).
    const snapshotRecord = snapshot as Record<string, unknown>;
    for (const field of versionedScalarFieldNames()) {
      if (field === 'systemInstructions') continue;
      const value = snapshotRecord[field];
      if (value === undefined) continue;
      updateData[field] = value;
    }

    // Wrap in a transaction to prevent race conditions on version numbering
    const { updated, nextVersion } = await prisma.$transaction(async (tx) => {
      const txUpdated = await tx.aiAgent.update({
        where: { id },
        data: updateData,
      });

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

    logAdminAction({
      userId: session.user.id,
      action: 'agent.version_restore',
      entityType: 'agent',
      entityId: id,
      metadata: { restoredFromVersion: version.version, newVersion: nextVersion },
      clientIp: clientIP,
    });

    return successResponse({
      agent: updated,
      restoredFromVersion: version.version,
      newVersion: nextVersion,
    });
  }
);
