/**
 * Admin Orchestration — Revert agent systemInstructions
 *
 * POST /api/v1/admin/orchestration/agents/:id/instructions-revert
 *   Body: { versionIndex: number }
 *   Replaces the current `systemInstructions` with the value at
 *   `systemInstructionsHistory[versionIndex]`. Before the swap, the
 *   current value is pushed onto history so the revert itself is
 *   auditable — otherwise the value you're reverting *from* would be
 *   lost forever. The revert also saves an agent version, like any other
 *   change to versioned config.
 *
 *   `versionIndex` is interpreted against the stored (oldest→newest)
 *   history array, the same ordering used in the DB. The history GET
 *   endpoint reverses entries for UI convenience but **annotates each
 *   entry with the same raw `versionIndex`** — callers should pass
 *   `history[n].versionIndex` from the GET response here rather than
 *   the array position `n`, otherwise a newest-first UI index would
 *   silently revert to the wrong version.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logger } from '@/lib/logging';
import {
  instructionsRevertSchema,
  systemInstructionsHistorySchema,
  type SystemInstructionsHistoryEntry,
} from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  ensureBaselineVersion,
  recordAgentVersion,
} from '@/lib/orchestration/agents/agent-versioning';

const REVERT_CHANGE_SUMMARY = 'Instructions: reverted to an earlier version';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'agent id' });

  const body = await validateRequestBody(request, instructionsRevertSchema);

  const current = await prisma.aiAgent.findUnique({
    where: { id },
    select: {
      id: true,
      isSystem: true,
      systemInstructions: true,
      systemInstructionsHistory: true,
    },
  });
  if (!current) throw new NotFoundError(`Agent ${id} not found`);

  if (current.isSystem) {
    throw new ForbiddenError('Cannot revert instructions on system agents');
  }

  const historyParse = systemInstructionsHistorySchema.safeParse(current.systemInstructionsHistory);
  if (!historyParse.success) {
    logger.warn('instructions-revert: systemInstructionsHistory malformed, refusing revert', {
      agentId: id,
      issues: historyParse.error.issues,
    });
    throw new ValidationError('Stored instructions history is malformed; cannot revert', {
      systemInstructionsHistory: ['Malformed history — contact a DBA'],
    });
  }

  const history: SystemInstructionsHistoryEntry[] = historyParse.data;
  if (history.length === 0) {
    throw new ValidationError('No instruction history available to revert', {
      versionIndex: ['This agent has no previous instructions to revert to'],
    });
  }
  if (body.versionIndex >= history.length) {
    throw new ValidationError('versionIndex out of range', {
      versionIndex: [`Must be between 0 and ${history.length - 1}`],
    });
  }

  const target = history[body.versionIndex];

  // Push the value we're reverting *from* onto history so it's recoverable.
  const nextHistory: SystemInstructionsHistoryEntry[] = [
    ...history,
    {
      instructions: current.systemInstructions,
      changedAt: new Date().toISOString(),
      changedBy: session.user.id,
    },
  ];

  // Instructions are versioned, so the revert saves a version in the same
  // transaction: the newest version must equal what the agent now runs, or
  // every chat turn after it is pinned to a config it did not run.
  const agent = await prisma.$transaction(async (tx) => {
    await ensureBaselineVersion(tx, id, session.user.id);
    const updated = await tx.aiAgent.update({
      where: { id },
      data: {
        systemInstructions: target.instructions,
        systemInstructionsHistory: nextHistory,
      },
    });
    await recordAgentVersion(tx, id, {
      changeSummary: REVERT_CHANGE_SUMMARY,
      createdBy: session.user.id,
    });
    return updated;
  });

  log.info('Agent systemInstructions reverted', {
    agentId: id,
    versionIndex: body.versionIndex,
    adminId: session.user.id,
    historyLength: nextHistory.length,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'agent.instructions_revert',
    entityType: 'agent',
    entityId: id,
    entityName: agent.name,
    metadata: { versionIndex: body.versionIndex, historyLength: nextHistory.length },
    clientIp: clientIP,
  });

  return successResponse(agent);
});
