/**
 * Stateless HMAC-signed approval tokens.
 *
 * Generates and verifies tokens that authorize an external actor to
 * approve or reject a specific workflow execution without a session.
 *
 * Token format: `<base64url-payload>.<base64url-signature>`
 *   payload = JSON { executionId, action, expiresAt }
 *   signature = HMAC-SHA256(BETTER_AUTH_SECRET, payload-bytes)
 *
 * No database storage or migration required — verification is purely
 * cryptographic. The actual approve/reject endpoints still use
 * optimistic locking on execution status to prevent double-action.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '@/lib/env';

/** Default token lifetime when the step config doesn't specify a timeout. */
const DEFAULT_EXPIRY_MINUTES = 7 * 24 * 60; // 7 days

export type ApprovalAction = 'approve' | 'reject';

interface TokenPayload {
  executionId: string;
  action: ApprovalAction;
  expiresAt: string; // ISO 8601
}

function getSecret(): string {
  return env.BETTER_AUTH_SECRET;
}

function base64UrlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64url');
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function sign(payloadJson: string): string {
  return createHmac('sha256', getSecret()).update(payloadJson, 'utf8').digest('base64url');
}

/**
 * Generate a signed approval token for the given execution and action.
 */
export function generateApprovalToken(
  executionId: string,
  action: ApprovalAction,
  expiresInMinutes: number = DEFAULT_EXPIRY_MINUTES
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000);
  const payload: TokenPayload = {
    executionId,
    action,
    expiresAt: expiresAt.toISOString(),
  };

  const payloadJson = JSON.stringify(payload);
  const encodedPayload = base64UrlEncode(payloadJson);
  const signature = sign(payloadJson);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt,
  };
}

/**
 * Verify a signed approval token. Returns the decoded payload on
 * success, or throws on tampered/expired/malformed tokens.
 */
export function verifyApprovalToken(token: string): TokenPayload {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) {
    throw new Error('Invalid approval token format');
  }

  const encodedPayload = token.slice(0, dotIndex);
  const providedSignature = token.slice(dotIndex + 1);

  let payloadJson: string;
  try {
    payloadJson = base64UrlDecode(encodedPayload);
  } catch {
    throw new Error('Invalid approval token encoding');
  }

  const expectedSignature = sign(payloadJson);

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(providedSignature, 'utf8');
  const b = Buffer.from(expectedSignature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid approval token signature');
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(payloadJson) as TokenPayload;
  } catch {
    throw new Error('Invalid approval token payload');
  }

  if (!payload.executionId || !payload.action || !payload.expiresAt) {
    throw new Error('Incomplete approval token payload');
  }

  const expiresAt = new Date(payload.expiresAt);
  if (isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new Error('Approval token has expired');
  }

  return payload;
}

/**
 * Build full approve/reject URLs for embedding in notifications.
 */
export function buildApprovalUrls(
  executionId: string,
  baseUrl: string,
  expiresInMinutes?: number
): { approveUrl: string; rejectUrl: string; expiresAt: Date } {
  const approve = generateApprovalToken(executionId, 'approve', expiresInMinutes);
  const reject = generateApprovalToken(executionId, 'reject', expiresInMinutes);

  return {
    approveUrl: `${baseUrl}/api/v1/orchestration/approvals/${executionId}/approve?token=${encodeURIComponent(approve.token)}`,
    rejectUrl: `${baseUrl}/api/v1/orchestration/approvals/${executionId}/reject?token=${encodeURIComponent(reject.token)}`,
    expiresAt: approve.expiresAt,
  };
}
