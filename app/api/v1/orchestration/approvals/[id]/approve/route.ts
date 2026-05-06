/**
 * Public Orchestration — Token-authenticated approve (external channel)
 *
 * POST /api/v1/orchestration/approvals/:id/approve?token=<signed-token>
 *
 * Used by email links, Slack buttons, and other non-browser callers.
 * No CORS — these clients dispatch directly server-to-server. The
 * `actorLabel` is pinned to `token:external`.
 *
 * Authentication: Stateless HMAC token (no session required).
 */

import { NextRequest } from 'next/server';
import { handleApproveRequest } from '@/lib/orchestration/approval-route-helpers';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  return handleApproveRequest(request, params, { actorLabel: 'token:external' });
}
