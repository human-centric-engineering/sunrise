/**
 * Public Orchestration — Token-authenticated reject (embed-widget channel)
 *
 * POST /api/v1/orchestration/approvals/:id/reject/embed?token=<signed-token>
 *
 * Sibling of `…/approve/embed`. Same CORS posture (allowlist via
 * `OrchestrationSettings.embedAllowedOrigins`) and
 * `actorLabel: 'token:embed'`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import {
  handleRejectRequest,
  allowlistCorsHeaders,
} from '@/lib/orchestration/approval-route-helpers';

export async function OPTIONS(request: NextRequest): Promise<Response> {
  const origin = request.headers.get('origin');
  const settings = await getOrchestrationSettings();
  const headers = allowlistCorsHeaders(origin, settings.embedAllowedOrigins, 'POST');
  if (!headers) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const origin = request.headers.get('origin');
  const settings = await getOrchestrationSettings();
  const corsHeaders = allowlistCorsHeaders(origin, settings.embedAllowedOrigins, 'POST');
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
    actorLabel: 'token:embed',
    corsHeaders,
  });
}
