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
 *   2. (conversation_turn) The source message's conversation also
 *      belongs to the caller.
 *   3. (workflow_execution) The source execution's workflow also
 *      belongs to the caller.
 * The capture helpers themselves are ownership-agnostic — they only
 * verify the cross-reference between message/execution and dataset.
 *
 * Inherits the default `/api/v1/**` 100/min rate-limit policy from the
 * proxy — capture is cheap (one transactional Prisma write, no LLM).
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { captureDatasetCaseSchema } from '@/lib/validations/orchestration-evaluations';
import {
  captureConversationTurnAsCase,
  captureWorkflowExecutionAsCase,
} from '@/lib/orchestration/evaluations/datasets/capture';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
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
    where: { id: datasetId, userId: session.user.id },
    select: { id: true },
  });
  if (!dataset) throw new NotFoundError(`Dataset ${datasetId} not found`);

  if (body.kind === 'conversation_turn') {
    // Source-side ownership: the conversation the message lives in must
    // belong to the same user. Without this check, a user could capture
    // another user's prod traffic into their own dataset.
    const message = await prisma.aiMessage.findUnique({
      where: { id: body.messageId },
      select: { conversation: { select: { userId: true } } },
    });
    if (!message || message.conversation.userId !== session.user.id) {
      throw new NotFoundError(`Message ${body.messageId} not found`);
    }

    const result = await captureConversationTurnAsCase({
      datasetId,
      messageId: body.messageId,
      ...(body.edits ? { edits: body.edits } : {}),
    });
    log.info('Captured conversation turn', {
      datasetId,
      messageId: body.messageId,
      newCaseCount: result.newCaseCount,
    });
    return successResponse(result, undefined, { status: 201 });
  }

  // workflow_execution
  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id: body.executionId },
    select: { userId: true },
  });
  if (!execution || execution.userId !== session.user.id) {
    throw new NotFoundError(`Workflow execution ${body.executionId} not found`);
  }

  const result = await captureWorkflowExecutionAsCase({
    datasetId,
    executionId: body.executionId,
    selector: body.selector,
    ...(body.edits ? { edits: body.edits } : {}),
  });
  log.info('Captured workflow execution', {
    datasetId,
    executionId: body.executionId,
    selectorKind: body.selector.kind,
    newCaseCount: result.newCaseCount,
  });
  return successResponse(result, undefined, { status: 201 });
});
