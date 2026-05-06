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
 * approve URL.
 *
 * CORS: permissive (`*`) so the embed widget can poll from third-party
 * origins. The data exposed is scoped to a single execution that the
 * caller is already authorised to act on; widening reads doesn't
 * change the security profile.
 */

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { verifyApprovalToken } from '@/lib/orchestration/approval-tokens';
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
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

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

  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      errorMessage: true,
      executionTrace: true,
      completedAt: true,
    },
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
