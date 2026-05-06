/**
 * Public Orchestration — Token-authenticated approve (embed-widget channel)
 *
 * POST /api/v1/orchestration/approvals/:id/approve/embed?token=<signed-token>
 *
 * Used by the embed widget when a hosted partner site renders the
 * in-chat approval card. CORS scope: the orchestration setting
 * `embedAllowedOrigins`. `actorLabel` is pinned to `token:embed`.
 *
 * Origins must be added by an admin in `OrchestrationSettings.embedAllowedOrigins`
 * before approve requests from a partner site succeed — there's no
 * inheritance from the per-token embed allowlist because that lives
 * on the `AiAgentEmbedToken` row, which we don't have access to from
 * the HMAC-token context (the HMAC payload only carries
 * `executionId`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import {
  handleApproveRequest,
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
  return handleApproveRequest(request, params, {
    actorLabel: 'token:embed',
    corsHeaders,
  });
}
