/**
 * Admin Orchestration — Trace-to-dataset capture.
 *
 * POST /api/v1/admin/orchestration/evaluations/datasets/:id/capture
 *   Convert a real prod conversation turn (or workflow execution
 *   output) into a new `AiDatasetCase` row on this dataset.
 *
 * Body (discriminated by `kind`):
 *   { kind: 'conversation_turn', messageId, edits? }
 *   { kind: 'workflow_execution', executionId, selector, edits? }
 *
 * Ownership chain enforced here:
 *   1. Dataset belongs to the caller.
 *   2. (conversation_turn) The caller owns the source message's
 *      conversation, or nobody does (a system-owned inbound thread).
 *      A `'shared'` basis is refused — see below.
 *   3. (workflow_execution) The caller owns the source execution, or
 *      nobody does (a schedule- or inbound-triggered run).
 *
 * Both source checks go through the shared access helpers so that
 * system-owned rows stay capturable; a hand-rolled `userId ===
 * session.user.id` comparison 404s every scheduled and inbound row now
 * that they carry `userId = null` (#502).
 *
 * The capture helpers themselves are ownership-agnostic — they only
 * verify the cross-reference between message/execution and dataset.
 *
 * Inherits the default `/api/v1/**` 100/min rate-limit policy from the
 * proxy — capture is cheap (one transactional Prisma write, no LLM).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import {
  datasetVisibilityWhere,
  datasetAccessBasis,
  logDatasetAccess,
} from '@/lib/orchestration/access/dataset-access';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { captureDatasetCaseSchema } from '@/lib/validations/orchestration-evaluations';
import { adminCanViewConversation } from '@/lib/orchestration/access/conversation-access';
import { adminCanViewExecution } from '@/lib/orchestration/access/execution-access';
import {
  captureConversationTurnAsCase,
  captureWorkflowExecutionAsCase,
} from '@/lib/orchestration/evaluations/datasets/capture';

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const id = cuidSchema.safeParse(rawId);
    if (!id.success) {
      throw new ValidationError('Invalid dataset id', { id: ['Must be a valid CUID'] });
    }
    const datasetId = id.data;

    const body = await validateRequestBody(request, captureDatasetCaseSchema);

    // Dataset ownership
    const dataset = await prisma.aiDataset.findFirst({
      where: { AND: [await datasetVisibilityWhere(session), { id: datasetId }] },
      select: { id: true, name: true, userId: true },
    });
    if (!dataset) throw new NotFoundError(`Dataset ${datasetId} not found`);

    if (body.kind === 'conversation_turn') {
      // Source-side ownership: the caller must own the conversation the message
      // lives in, or nobody must own it. Without this check, a user could
      // capture another user's prod traffic into their own dataset.
      //
      // A `'shared'` basis is deliberately refused: a share grants view consent,
      // not consent to copy the turn into someone else's dataset, where it
      // outlives the share and is no longer reachable by a revoke.
      const message = await prisma.aiMessage.findUnique({
        where: { id: body.messageId },
        select: { conversationId: true },
      });
      if (!message) throw new NotFoundError(`Message ${body.messageId} not found`);

      const access = await adminCanViewConversation(message.conversationId, session.user.id);
      if (access.basis !== 'owner' && access.basis !== 'system') {
        throw new NotFoundError(`Message ${body.messageId} not found`);
      }

      const result = await captureConversationTurnAsCase({
        datasetId,
        messageId: body.messageId,
        observedOwnerId: dataset.userId,
        ...(body.edits ? { edits: body.edits } : {}),
      });
      logDatasetAccess({
        adminUserId: session.user.id,
        datasetId,
        datasetName: dataset.name,
        basis: datasetAccessBasis(dataset, session.user.id) ?? 'orphan',
        action: 'dataset.case_capture',
        extra: { kind: 'conversation_turn' },
        clientIp: getClientIP(request),
      });
      log.info('Captured conversation turn', {
        datasetId,
        messageId: body.messageId,
        newCaseCount: result.newCaseCount,
      });
      return successResponse(result, undefined, { status: 201 });
    }

    // workflow_execution — the caller's own run, or a system-owned one
    // (schedule/inbound). Capturing a scheduled run's output into a dataset is
    // a core evaluation workflow; an owner-only check would 404 every one of
    // them now that they carry `userId = null`.
    const execution = await prisma.aiWorkflowExecution.findUnique({
      where: { id: body.executionId },
      select: { userId: true },
    });
    if (!execution || !adminCanViewExecution(execution, session.user.id)) {
      throw new NotFoundError(`Workflow execution ${body.executionId} not found`);
    }

    const result = await captureWorkflowExecutionAsCase({
      datasetId,
      executionId: body.executionId,
      selector: body.selector,
      observedOwnerId: dataset.userId,
      ...(body.edits ? { edits: body.edits } : {}),
    });
    logDatasetAccess({
      adminUserId: session.user.id,
      datasetId,
      datasetName: dataset.name,
      basis: datasetAccessBasis(dataset, session.user.id) ?? 'orphan',
      action: 'dataset.case_capture',
      extra: { kind: 'workflow_execution' },
      clientIp: getClientIP(request),
    });
    log.info('Captured workflow execution', {
      datasetId,
      executionId: body.executionId,
      selectorKind: body.selector.kind,
      newCaseCount: result.newCaseCount,
    });
    return successResponse(result, undefined, { status: 201 });
  },
  {
    ownership: {
      decidedBy: 'self',
      because:
        'Resolves the dataset under the visible clause for this caller — rows they own, or rows nobody owns where canRead permits an unattributed read — before touching it. Never a row belonging to another subject.',
    },
  }
);
