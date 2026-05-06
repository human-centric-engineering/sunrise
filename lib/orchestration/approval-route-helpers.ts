/**
 * Shared route helpers for the public approval endpoints.
 *
 * The existing `/approvals/:id/{approve,reject}` routes serve external
 * channels (email, Slack) with no CORS. Two new sibling sub-routes per
 * action — `/approve/chat`, `/approve/embed`, `/reject/chat`,
 * `/reject/embed` — provide channel-specific entry points so the
 * server can pin the actor label and the CORS posture on the route
 * itself, rather than trusting a body field. The five route files
 * differ only in (a) which `actorLabel` they pass and (b) whether/how
 * they respond to OPTIONS preflight; everything else is centralised
 * here.
 *
 * Why not just let any caller hit `/approve` with a `?source=chat`
 * query: the actor label is server-set so a leaked HMAC token can't
 * be replayed under a misleading channel name in audit logs, and CORS
 * scoping differs per channel — admin chat is same-origin, the embed
 * widget is allowlist, and the legacy email/Slack route has no CORS.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { verifyApprovalToken } from '@/lib/orchestration/approval-tokens';
import { executeApproval, executeRejection } from '@/lib/orchestration/approval-actions';
import { cuidSchema } from '@/lib/validations/common';
import { logger } from '@/lib/logging';

const approveBodySchema = z.object({
  notes: z.string().max(5000).optional(),
});

const rejectBodySchema = z.object({
  reason: z.string().min(1).max(5000),
});

export type ApprovalActorLabel = 'token:external' | 'token:chat' | 'token:embed';

export interface ApprovalRouteOptions {
  actorLabel: ApprovalActorLabel;
  /** Optional CORS headers to apply to every response (success + error). */
  corsHeaders?: Record<string, string>;
}

function applyCors(response: Response, headers: Record<string, string> | undefined): Response {
  if (!headers) return response;
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

/**
 * Process an approve request end-to-end. Used by the shared helper
 * routes; channel-specific routes call this with their fixed
 * `actorLabel` and any CORS headers already resolved at the route
 * boundary.
 */
export async function handleApproveRequest(
  request: NextRequest,
  params: Promise<{ id: string }>,
  opts: ApprovalRouteOptions
): Promise<Response> {
  const cors = opts.corsHeaders;
  const wrap = (r: Response): Response => applyCors(r, cors);

  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return wrap(createRateLimitResponse(rateLimit));

  const { id: rawId } = await params;
  const idParse = cuidSchema.safeParse(rawId);
  if (!idParse.success) {
    return wrap(errorResponse('Invalid execution id', { code: 'VALIDATION_ERROR', status: 400 }));
  }
  const id = idParse.data;

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return wrap(errorResponse('Missing approval token', { code: 'UNAUTHORIZED', status: 401 }));
  }

  try {
    const payload = verifyApprovalToken(token);
    if (payload.action !== 'approve') {
      return wrap(
        errorResponse('Token action mismatch: expected approve', {
          code: 'VALIDATION_ERROR',
          status: 400,
        })
      );
    }
    if (payload.executionId !== id) {
      return wrap(
        errorResponse('Token execution id mismatch', { code: 'VALIDATION_ERROR', status: 400 })
      );
    }
  } catch {
    return wrap(
      errorResponse('Invalid or expired approval token', { code: 'UNAUTHORIZED', status: 401 })
    );
  }

  let notes: string | undefined;
  try {
    const rawBody = await request.text();
    if (rawBody.trim()) {
      const bodyParse = approveBodySchema.safeParse(JSON.parse(rawBody));
      if (bodyParse.success) {
        notes = bodyParse.data.notes;
      }
    }
  } catch {
    // Body parsing failure is non-fatal — `notes` is optional on approve.
  }

  try {
    const result = await executeApproval(id, { notes, actorLabel: opts.actorLabel });
    return wrap(successResponse(result));
  } catch (err) {
    return wrap(mapActionError(err, 'approve'));
  }
}

/**
 * Process a reject request end-to-end. `reason` is required; bad
 * bodies surface as 400 rather than the silent fallback approve uses.
 */
export async function handleRejectRequest(
  request: NextRequest,
  params: Promise<{ id: string }>,
  opts: ApprovalRouteOptions
): Promise<Response> {
  const cors = opts.corsHeaders;
  const wrap = (r: Response): Response => applyCors(r, cors);

  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return wrap(createRateLimitResponse(rateLimit));

  const { id: rawId } = await params;
  const idParse = cuidSchema.safeParse(rawId);
  if (!idParse.success) {
    return wrap(errorResponse('Invalid execution id', { code: 'VALIDATION_ERROR', status: 400 }));
  }
  const id = idParse.data;

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return wrap(errorResponse('Missing approval token', { code: 'UNAUTHORIZED', status: 401 }));
  }

  try {
    const payload = verifyApprovalToken(token);
    if (payload.action !== 'reject') {
      return wrap(
        errorResponse('Token action mismatch: expected reject', {
          code: 'VALIDATION_ERROR',
          status: 400,
        })
      );
    }
    if (payload.executionId !== id) {
      return wrap(
        errorResponse('Token execution id mismatch', { code: 'VALIDATION_ERROR', status: 400 })
      );
    }
  } catch {
    return wrap(
      errorResponse('Invalid or expired approval token', { code: 'UNAUTHORIZED', status: 401 })
    );
  }

  let body: z.infer<typeof rejectBodySchema>;
  try {
    const rawBody: unknown = await request.json();
    const bodyParse = rejectBodySchema.safeParse(rawBody);
    if (!bodyParse.success) {
      return wrap(
        errorResponse('Reason is required (1–5000 characters)', {
          code: 'VALIDATION_ERROR',
          status: 400,
        })
      );
    }
    body = bodyParse.data;
  } catch {
    return wrap(
      errorResponse('Invalid request body: reason is required', {
        code: 'VALIDATION_ERROR',
        status: 400,
      })
    );
  }

  try {
    const result = await executeRejection(id, {
      reason: body.reason,
      actorLabel: opts.actorLabel,
    });
    return wrap(successResponse(result));
  } catch (err) {
    return wrap(mapActionError(err, 'reject'));
  }
}

function mapActionError(err: unknown, kind: 'approve' | 'reject'): Response {
  const error = err as Error & { code?: string };
  switch (error.code) {
    case 'NOT_FOUND':
      return errorResponse(error.message, { code: 'NOT_FOUND', status: 404 });
    case 'INVALID_STATUS':
      return errorResponse('Execution is not awaiting approval', {
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    case 'TRACE_CORRUPTED':
      return errorResponse('Execution trace is corrupted', {
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    case 'CONCURRENT':
      return errorResponse('Execution was already processed', { code: 'CONFLICT', status: 409 });
    default:
      logger.error(`token ${kind} failed`, err);
      return errorResponse('Unexpected error', { code: 'INTERNAL_ERROR', status: 500 });
  }
}

/** Build CORS headers for a single allowed origin, rejecting `null`. */
export function singleOriginCorsHeaders(
  requestOrigin: string | null,
  allowedOrigin: string,
  methods: string
): Record<string, string> | undefined {
  if (!requestOrigin || requestOrigin === 'null' || requestOrigin !== allowedOrigin) {
    return undefined;
  }
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': `${methods}, OPTIONS`,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Build CORS headers for an allowlist, rejecting `null` and non-listed origins. */
export function allowlistCorsHeaders(
  requestOrigin: string | null,
  allowedOrigins: string[],
  methods: string
): Record<string, string> | undefined {
  if (!requestOrigin || requestOrigin === 'null' || !allowedOrigins.includes(requestOrigin)) {
    return undefined;
  }
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Methods': `${methods}, OPTIONS`,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
