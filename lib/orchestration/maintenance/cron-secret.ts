/**
 * The maintenance tick's cron credential (#1130).
 *
 * A scale-to-zero database (Neon) suspends only after minutes with no query,
 * and the idle gate (#442) lets an idle tick answer without one. Authenticating
 * the cron with an admin API key spent that saving before the gate ran: the
 * proxy's rate limiter looks the key up (its cache lasts 60 s), and
 * `resolveApiKey` reads the key row and writes `lastUsedAt`. One query a
 * minute keeps the database awake.
 *
 * So the tick's GET accepts a bearer equal to `CRON_SECRET`, the variable
 * Vercel Cron sends as `Authorization: Bearer $CRON_SECRET`, compared here with
 * no database. Set it to a random value (`openssl rand -base64 32`).
 *
 * **An `sk_` value is never matched here.** Setting `CRON_SECRET` to an admin
 * API key was the documented setup before #1130. Matched here, that key would
 * keep firing the tick after it was revoked or its owner stopped being a
 * platform admin (#746), since only `resolveApiKey` knows either. So it goes
 * through the admin-key guard, which checks both, as it always did.
 *
 * Read from `process.env` rather than the core env schema, because a fork may
 * already declare `CRON_SECRET` in its own `lib/app/env.ts` (ConQuest does, for
 * its own cron route), and a core key of the same name fails its boot.
 *
 * Fails closed: unset, shorter than {@link MIN_CRON_SECRET_LENGTH}, padded with
 * whitespace or starting `sk_` in any case, and no bearer matches, so the request falls
 * through to the admin-key guard. A set value that is ignored is logged once
 * per process, since the cron then gets a bare 401.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { API_KEY_PREFIX } from '@/lib/auth/api-keys';
import { logger } from '@/lib/logging';

/**
 * Shortest `CRON_SECRET` honoured. ConQuest's schema requires the same, and
 * `openssl rand -base64 32` gives 44.
 */
export const MIN_CRON_SECRET_LENGTH = 32;

/** Why a set `CRON_SECRET` is not used, or null when it is. */
function unusableBecause(secret: string): string | null {
  if (secret.length < MIN_CRON_SECRET_LENGTH) {
    return `it is shorter than ${MIN_CRON_SECRET_LENGTH} characters`;
  }
  if (secret !== secret.trim()) return 'it starts or ends with whitespace';
  // Any case: the proxy looks up `Bearer sk_…` case-insensitively
  // (`rate-limit-policy.ts`), so an `SK_` value would still cost that query.
  if (secret.toLowerCase().startsWith(API_KEY_PREFIX)) {
    return `it starts with "${API_KEY_PREFIX}", which the rate limiter looks up as an API key`;
  }
  return null;
}

let warned = false;

/** SHA-256 of a string, so the comparison below is constant-time whatever the lengths. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Whether the request carries `Authorization: Bearer <CRON_SECRET>`. Parsed as
 * `resolveApiKey` parses it: a case-sensitive `Bearer ` and the rest verbatim.
 */
export function isMaintenanceCronRequest(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;

  const reason = unusableBecause(secret);
  if (reason) {
    // A real sk_ key is the pre-#1130 setup and still works through the guard,
    // so it is not reported; an `SK_…` value works nowhere, so it is.
    if (!warned && !secret.startsWith(API_KEY_PREFIX)) {
      warned = true;
      logger.warn(`Maintenance tick: CRON_SECRET is set but ignored, because ${reason}`, {
        hint: 'Set CRON_SECRET to a random value: openssl rand -base64 32',
      });
    }
    return false;
  }

  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(secret));
}

/** Test-only: let the next ignored secret log again. */
export function __resetCronSecretWarningForTests(): void {
  warned = false;
}
