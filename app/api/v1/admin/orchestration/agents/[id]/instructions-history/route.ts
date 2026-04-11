/**
 * Admin Orchestration — Agent system-instructions history
 *
 * GET /api/v1/admin/orchestration/agents/:id/instructions-history
 *   Returns the agent's current `systemInstructions` plus the
 *   `systemInstructionsHistory` array (newest first). Each returned
 *   entry carries an explicit `versionIndex` field that references the
 *   raw (oldest→newest) DB array position — this is the exact value the
 *   `/instructions-revert` endpoint expects, so clients never have to
 *   invert indices themselves. The history column is parsed via
 *   `systemInstructionsHistorySchema` with warn-and-skip on malformed
 *   rows — same pattern used by the capability dispatcher.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { logger } from '@/lib/logging';
import {
  systemInstructionsHistorySchema,
  type SystemInstructionsHistoryEntry,
} from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

function parseAgentId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const agent = await prisma.aiAgent.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      systemInstructions: true,
      systemInstructionsHistory: true,
    },
  });
  if (!agent) throw new NotFoundError(`Agent ${id} not found`);

  const parsed = systemInstructionsHistorySchema.safeParse(agent.systemInstructionsHistory);
  let entries: SystemInstructionsHistoryEntry[];
  if (parsed.success) {
    entries = parsed.data;
  } else {
    logger.warn('instructions-history: malformed history JSON, returning empty array', {
      agentId: id,
      issues: parsed.error.issues,
    });
    entries = [];
  }

  // Annotate each entry with its raw (oldest→newest) DB index BEFORE
  // reversing — that index is what /instructions-revert expects, so
  // clients can pass `history[n].versionIndex` directly without having
  // to know which end of the array is "newest".
  const annotated = entries.map((entry, versionIndex) => ({ ...entry, versionIndex }));

  // Newest first for easier UI rendering.
  const history = annotated.reverse();

  log.info('Instructions history fetched', { agentId: id, entries: history.length });

  return successResponse({
    agentId: agent.id,
    slug: agent.slug,
    current: agent.systemInstructions,
    history,
  });
});
