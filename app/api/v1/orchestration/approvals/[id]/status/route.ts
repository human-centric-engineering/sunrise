/**
 * Public Orchestration — Token-authenticated execution status
 *
 * GET /api/v1/orchestration/approvals/:id/status?token=<signed-token>
 *
 * Returns the current state of a paused execution to a holder of a
 * valid HMAC approval token. Used by chat-rendered approval cards
 * (admin chat + embed widget) to poll the execution after the user
 * approves or rejects in-conversation, then surface the workflow
 * output as a follow-up turn.
 *
 * Auth posture mirrors the sibling approve/reject routes: stateless
 * HMAC verification only — no session, no admin check. Anyone with a
 * valid unexpired token can read status. The token's audience is the
 * end user themselves; leaking it has the same impact as leaking an
 * approve URL. The read runs inside the execution's own org, entered the
 * way the approve/reject helpers enter it (`runAsExecutionOrg`, §107
 * t-708); an execution that cannot enter its org is a 404.
 *
 * CORS: permissive (`*`) so the embed widget can poll from third-party
 * origins. The data exposed is scoped to a single execution that the
 * caller is already authorised to act on; widening reads doesn't
 * change the security profile.
 */

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { verifyApprovalToken } from '@/lib/orchestration/approval-tokens';
import { runAsExecutionOrg } from '@/lib/orchestration/approval-route-helpers';
import { prisma } from '@/lib/db/client';
import { cuidSchema } from '@/lib/validations/common';
import { executionTraceSchema } from '@/lib/validations/orchestration';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export function OPTIONS(): Response {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    return withCors(
      errorResponse('Invalid execution id', { code: 'VALIDATION_ERROR', status: 400 })
    );
  }
  const id = parsed.data;

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return withCors(errorResponse('Missing approval token', { code: 'UNAUTHORIZED', status: 401 }));
  }

  try {
    const payload = verifyApprovalToken(token);
    if (payload.executionId !== id) {
      return withCors(
        errorResponse('Token execution id mismatch', { code: 'VALIDATION_ERROR', status: 400 })
      );
    }
  } catch {
    return withCors(
      errorResponse('Invalid or expired approval token', {
        code: 'UNAUTHORIZED',
        status: 401,
      })
    );
  }

  const execution = await runAsExecutionOrg(id, () =>
    prisma.aiWorkflowExecution.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        errorMessage: true,
        executionTrace: true,
        completedAt: true,
      },
    })
  ).catch((err: unknown) => {
    if ((err as { code?: string }).code === 'NOT_FOUND') return null;
    throw err;
  });
  if (!execution) {
    return withCors(errorResponse('Execution not found', { code: 'NOT_FOUND', status: 404 }));
  }

  const trace = executionTraceSchema.parse(execution.executionTrace);

  return withCors(
    successResponse({
      id: execution.id,
      status: execution.status,
      errorMessage: execution.errorMessage,
      completedAt: execution.completedAt?.toISOString() ?? null,
      executionTrace: trace,
    })
  );
}

function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
  return response;
}
