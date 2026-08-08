/**
 * Stateless HMAC-signed approval tokens.
 *
 * Generates and verifies tokens that authorize an external actor to
 * approve or reject a specific workflow execution without a session.
 *
 * Token format: `<base64url-payload>.<base64url-signature>`
 *   payload = JSON { typ: 'workflow-approval', executionId, action, expiresAt }
 *   signature = HMAC-SHA256(BETTER_AUTH_SECRET, payload-bytes)
 *
 * No database storage or migration required — verification is purely
 * cryptographic. The actual approve/reject endpoints still use
 * optimistic locking on execution status to prevent double-action.
 *
 * **`typ` is what separates this scheme from `lib/storage/access-tokens.ts`.**
 * Both sign the same construction with the same secret, so a MAC check alone
 * cannot tell the two protocols apart: a signature minted there verifies
 * structurally here. What kept cross-scheme replay closed before #507 was only
 * that the two payload schemas happened to be disjoint on required fields
 * (`executionId` vs `key`) — an accident of the current shapes that stops
 * holding the day either side gains an optional field, with nothing in either
 * file to flag that as security-relevant. The tag is inside the signed bytes
 * and is asserted on verify, so the separation is now structural.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { isRecord } from '@/lib/utils';

/** Default token lifetime when the step config doesn't specify a timeout. */
const DEFAULT_EXPIRY_MINUTES = 7 * 24 * 60; // 7 days

/**
 * Scheme tag carried in the signed payload and asserted on verify — see the
 * module header. Changing this string invalidates every outstanding token.
 */
const TOKEN_TYPE = 'workflow-approval';

export type ApprovalAction = 'approve' | 'reject';

const tokenPayloadSchema = z.object({
  typ: z.literal(TOKEN_TYPE),
  executionId: z.string().min(1),
  action: z.enum(['approve', 'reject']),
  expiresAt: z.string().min(1),
});

type TokenPayload = z.infer<typeof tokenPayloadSchema>;

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
    typ: TOKEN_TYPE,
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
 * Say which of the three schema failures happened, in the terms an operator
 * reading a rejected approval needs.
 *
 * A missing tag and a wrong tag are different events and must not share a
 * message. A *wrong* tag is a token from the storage scheme: authentically
 * signed, complete, and presented at the wrong door. A *missing* tag is,
 * during the upgrade window, almost always a token minted before the tag
 * existed — the scheme was right and the token merely predates the check.
 * Reporting that as "not a workflow-approval token" would send whoever is
 * debugging the deploy looking for a cross-scheme bug that isn't there.
 */
function describePayloadFailure(raw: unknown): string {
  if (!isRecord(raw)) return 'Incomplete approval token payload';
  if (raw.typ === undefined) return 'Approval token payload is missing its scheme tag';
  if (raw.typ !== TOKEN_TYPE) return 'Approval token payload is not a workflow-approval token';
  return 'Incomplete approval token payload';
}

/**
 * Verify a signed approval token. Returns the decoded payload on
 * success, or throws on tampered/expired/malformed tokens, and on an
 * authentic token belonging to another scheme signed with the same secret
 * (see `typ` in the module header).
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

  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    throw new Error('Invalid approval token payload');
  }

  const parsed = tokenPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(describePayloadFailure(raw));
  }
  const payload = parsed.data;

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
