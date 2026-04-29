/**
 * Public Orchestration — Token-authenticated reject
 *
 * POST /api/v1/orchestration/approvals/:id/reject?token=<signed-token>
 *
 * Allows external systems (Slack, email, WhatsApp) to reject a paused
 * execution using a signed HMAC token instead of a session cookie.
 *
 * Authentication: Stateless HMAC token (no session required).
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { verifyApprovalToken } from '@/lib/orchestration/approval-tokens';
import { executeRejection } from '@/lib/orchestration/approval-actions';
import { cuidSchema } from '@/lib/validations/common';
import { logger } from '@/lib/logging';

const bodySchema = z.object({
  reason: z.string().min(1).max(5000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    return errorResponse('Invalid execution id', { code: 'VALIDATION_ERROR', status: 400 });
  }
  const id = parsed.data;

  // Verify token from query string
  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return errorResponse('Missing approval token', { code: 'UNAUTHORIZED', status: 401 });
  }

  try {
    const payload = verifyApprovalToken(token);

    if (payload.action !== 'reject') {
      return errorResponse('Token action mismatch: expected reject', {
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    }
    if (payload.executionId !== id) {
      return errorResponse('Token execution id mismatch', {
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    }
  } catch {
    return errorResponse('Invalid or expired approval token', {
      code: 'UNAUTHORIZED',
      status: 401,
    });
  }

  // Parse required body
  let body: z.infer<typeof bodySchema>;
  try {
    const rawBody: unknown = await request.json();
    const bodyParse = bodySchema.safeParse(rawBody);
    if (!bodyParse.success) {
      return errorResponse('Reason is required (1–5000 characters)', {
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    }
    body = bodyParse.data;
  } catch {
    return errorResponse('Invalid request body: reason is required', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }

  try {
    const result = await executeRejection(id, {
      reason: body.reason,
      actorLabel: 'token:external',
    });
    return successResponse(result);
  } catch (err) {
    const error = err as Error & { code?: string };
    switch (error.code) {
      case 'NOT_FOUND':
        return errorResponse(error.message, { code: 'NOT_FOUND', status: 404 });
      case 'INVALID_STATUS':
        return errorResponse('Execution is not awaiting approval', {
          code: 'VALIDATION_ERROR',
          status: 400,
        });
      case 'CONCURRENT':
        return errorResponse('Execution was already processed', { code: 'CONFLICT', status: 409 });
      default:
        logger.error('token reject failed', err);
        return errorResponse('Unexpected error', { code: 'INTERNAL_ERROR', status: 500 });
    }
  }
}
