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
 * no database. Set it to a random value (`openssl rand -base64 32`), not an
 * `sk_` key: the proxy looks up any `Bearer sk_…` on the orchestration admin
 * routes, so an `sk_` value still costs that query.
 *
 * Read from `process.env` rather than the core env schema, because a fork may
 * already declare `CRON_SECRET` in its own `lib/app/env.ts` (ConQuest does, for
 * its own cron route), and a core key of the same name fails its boot.
 *
 * Fails closed: unset, or shorter than {@link MIN_CRON_SECRET_LENGTH}, and no
 * bearer matches, so the request falls through to the admin-key guard.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

/**
 * Shortest `CRON_SECRET` honoured. ConQuest's schema requires the same, and
 * `openssl rand -base64 32` gives 44; an `sk_` key is 67.
 */
export const MIN_CRON_SECRET_LENGTH = 32;

const cronSecretSchema = z.string().min(MIN_CRON_SECRET_LENGTH);

/** SHA-256 of a string, so the comparison below is constant-time whatever the lengths. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Whether the request carries `Authorization: Bearer <CRON_SECRET>`. Parsed as
 * `resolveApiKey` parses it: a case-sensitive `Bearer ` and the rest verbatim.
 */
export function isMaintenanceCronRequest(request: NextRequest): boolean {
  const secret = cronSecretSchema.safeParse(process.env.CRON_SECRET);
  if (!secret.success) return false;

  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;

  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(secret.data));
}
