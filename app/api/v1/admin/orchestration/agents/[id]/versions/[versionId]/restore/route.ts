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

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
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
import {
  SYSTEM_AGENT_PROTECTED_FIELDS,
  getAgentField,
  versionedScalarFieldNames,
} from '@/lib/orchestration/agents/agent-field-registry';
import {
  asSnapshotJson,
  buildAgentSnapshot,
  nextAgentVersionNumber,
} from '@/lib/orchestration/agents/agent-versioning';
import { invalidateAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';

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

    const agent = await prisma.aiAgent.findUnique({
      where: { id },
      include: {
        grantedTags: { select: { tagId: true } },
        grantedDocuments: { select: { documentId: true } },
      },
    });
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
    const snapshotRecord = snapshot as Record<string, unknown>;

    // System agents are restorable, but the same fields the PATCH route guards
    // as read-only stay untouched: a restore must not revert a system agent's
    // slug, systemInstructions, or active state to an arbitrary snapshot — that
    // would defeat the platform's read-only guarantees. Every other versioned
    // field (model, guard modes, persona, knowledge config, grants) is restored.
    // Non-system agents restore the full config.
    const skip = agent.isSystem
      ? new Set<string>(SYSTEM_AGENT_PROTECTED_FIELDS)
      : new Set<string>();

    const updateData: Record<string, unknown> = {};

    // systemInstructions is restored with history tracking: push the current
    // value onto the history column (same pattern as the PATCH route) before
    // overwriting. Skipped entirely for system agents (protected, read-only).
    if (
      !skip.has('systemInstructions') &&
      snapshot.systemInstructions !== undefined &&
      snapshot.systemInstructions !== agent.systemInstructions
    ) {
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
    } else if (!skip.has('systemInstructions') && snapshot.systemInstructions !== undefined) {
      updateData.systemInstructions = snapshot.systemInstructions;
    }

    // Apply every other versioned scalar present in the snapshot. The set is
    // registry-derived, so restore covers the full versioned config by
    // construction. knowledgeAccessMode IS restored here now (alongside the
    // grants below + the cache invalidation) — it was deferred in #333 because
    // restore didn't yet reapply grants; #330 closes that.
    for (const field of versionedScalarFieldNames()) {
      if (field === 'systemInstructions') continue; // handled above (history-tracked)
      if (skip.has(field)) continue; // protected system fields
      const value = snapshotRecord[field];
      if (value === undefined) continue;
      // JSON columns (metadata/providerConfig) reject a literal null on write —
      // coerce to Prisma.JsonNull, as the create/clone/import paths do.
      updateData[field] = getAgentField(field)?.json && value === null ? Prisma.JsonNull : value;
    }

    // Resolve the knowledge grants this restore lands on. Snapshots capture
    // grants by value; restore them so the agent's knowledge access matches the
    // target version. Tags/documents deleted since the snapshot are dropped (a
    // stale id would FK-fail the whole restore) and logged. A snapshot that
    // predates grant versioning (no grant keys) leaves grants untouched.
    const currentTagIds = (agent.grantedTags ?? []).map((g) => g.tagId);
    const currentDocumentIds = (agent.grantedDocuments ?? []).map((g) => g.documentId);

    const snapshotTagIds = Array.isArray(snapshotRecord.grantedTagIds)
      ? snapshotRecord.grantedTagIds.filter((v): v is string => typeof v === 'string')
      : undefined;
    const snapshotDocumentIds = Array.isArray(snapshotRecord.grantedDocumentIds)
      ? snapshotRecord.grantedDocumentIds.filter((v): v is string => typeof v === 'string')
      : undefined;

    let resolvedTagIds = currentTagIds;
    if (snapshotTagIds !== undefined) {
      const existing =
        snapshotTagIds.length > 0
          ? await prisma.knowledgeTag.findMany({
              where: { id: { in: snapshotTagIds } },
              select: { id: true },
            })
          : [];
      const existingIds = new Set(existing.map((t) => t.id));
      resolvedTagIds = snapshotTagIds.filter((tid) => existingIds.has(tid));
      const dropped = snapshotTagIds.filter((tid) => !existingIds.has(tid));
      if (dropped.length > 0) {
        logger.warn('Restore: dropping tag grants for tags deleted since the snapshot', {
          agentId: id,
          versionId,
          dropped,
        });
      }
    }

    let resolvedDocumentIds = currentDocumentIds;
    if (snapshotDocumentIds !== undefined) {
      const existing =
        snapshotDocumentIds.length > 0
          ? await prisma.aiKnowledgeDocument.findMany({
              where: { id: { in: snapshotDocumentIds } },
              select: { id: true },
            })
          : [];
      const existingIds = new Set(existing.map((d) => d.id));
      resolvedDocumentIds = snapshotDocumentIds.filter((did) => existingIds.has(did));
      const dropped = snapshotDocumentIds.filter((did) => !existingIds.has(did));
      if (dropped.length > 0) {
        logger.warn('Restore: dropping document grants for documents deleted since the snapshot', {
          agentId: id,
          versionId,
          dropped,
        });
      }
    }

    // Apply the restore + the post-restore version in one transaction. The new
    // version snapshots the RESULTING (post-restore) config — point-in-time, so
    // it equals the target version's config except for any protected system
    // fields left at their current values. The pre-restore state is already the
    // agent's newest version (newest-row-equals-live), so it needs no separate
    // snapshot.
    const { updated, nextVersion } = await prisma.$transaction(async (tx) => {
      const txUpdated = await tx.aiAgent.update({ where: { id }, data: updateData });

      // Replace grants only when the snapshot carried them.
      if (snapshotTagIds !== undefined) {
        await tx.aiAgentKnowledgeTag.deleteMany({ where: { agentId: id } });
        if (resolvedTagIds.length > 0) {
          await tx.aiAgentKnowledgeTag.createMany({
            data: resolvedTagIds.map((tagId) => ({ agentId: id, tagId })),
            skipDuplicates: true,
          });
        }
      }
      if (snapshotDocumentIds !== undefined) {
        await tx.aiAgentKnowledgeDocument.deleteMany({ where: { agentId: id } });
        if (resolvedDocumentIds.length > 0) {
          await tx.aiAgentKnowledgeDocument.createMany({
            data: resolvedDocumentIds.map((documentId) => ({ agentId: id, documentId })),
            skipDuplicates: true,
          });
        }
      }

      const txNextVersion = await nextAgentVersionNumber(tx, id);
      await tx.aiAgentVersion.create({
        data: {
          agentId: id,
          version: txNextVersion,
          snapshot: asSnapshotJson(
            buildAgentSnapshot(txUpdated, {
              grantedTagIds: resolvedTagIds,
              grantedDocumentIds: resolvedDocumentIds,
            })
          ),
          changeSummary: `Restored from version ${version.version}`,
          createdBy: session.user.id,
        },
      });

      return { updated: txUpdated, nextVersion: txNextVersion };
    });

    // The restore may have changed knowledgeAccessMode and/or the grants — evict
    // the resolver cache so the next chat turn sees the restored access.
    invalidateAgentAccess(id);

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
