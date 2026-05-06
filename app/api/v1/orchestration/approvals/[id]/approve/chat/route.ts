/**
 * Public Orchestration — Token-authenticated approve (admin chat channel)
 *
 * POST /api/v1/orchestration/approvals/:id/approve/chat?token=<signed-token>
 *
 * Used by the admin chat surface to approve a paused execution
 * surfaced inline via an `approval_required` SSE event. CORS: only the
 * deployment's own origin (env.NEXT_PUBLIC_APP_URL); rejects `null`
 * Origin (sandboxed iframes, file:// loads). The `actorLabel` is
 * pinned to `token:chat`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import {
  handleApproveRequest,
  singleOriginCorsHeaders,
} from '@/lib/orchestration/approval-route-helpers';

export function OPTIONS(request: NextRequest): Response {
  const origin = request.headers.get('origin');
  const headers = singleOriginCorsHeaders(origin, env.NEXT_PUBLIC_APP_URL, 'POST');
  if (!headers) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const origin = request.headers.get('origin');
  const corsHeaders = singleOriginCorsHeaders(origin, env.NEXT_PUBLIC_APP_URL, 'POST');
  if (!corsHeaders) {
    return new NextResponse(
      JSON.stringify({
        success: false,
        error: { code: 'ORIGIN_DENIED', message: 'Origin not allowed' },
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return handleApproveRequest(request, params, {
    actorLabel: 'token:chat',
    corsHeaders,
    triggerResume: true,
  });
}
