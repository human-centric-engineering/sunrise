/**
 * Public Orchestration — Token-authenticated reject (admin chat channel)
 *
 * POST /api/v1/orchestration/approvals/:id/reject/chat?token=<signed-token>
 *
 * Sibling of `…/approve/chat`. Same CORS posture (deployment origin
 * only, `null` rejected) and `actorLabel: 'token:chat'`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import {
  handleRejectRequest,
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
  return handleRejectRequest(request, params, {
    actorLabel: 'token:chat',
    corsHeaders,
  });
}
