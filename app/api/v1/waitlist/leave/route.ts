/**
 * Waitlist — leave (§125 t-977)
 *
 * POST /api/v1/waitlist/leave — `{ token }`, from the button on the page every
 * waitlist email links to (`/waitlist/leave`). Erases the entry and writes a
 * waitlist-only erasure receipt (`eraseWaitlistEntry()`, reason
 * `self_service`). Opening the link alone erases nothing.
 *
 * Authentication: none — the signed token is the credential. It has no
 * expiry: it works for as long as the entry exists.
 *
 * **Works with no waitlist config and with the list closed.** No switch may
 * stop someone leaving the list: a fork that drops its config still has the
 * entries, and the links in people's inboxes must still take them off. With
 * nothing ever joined, every token is invalid, so an install without a
 * waitlist is unaffected.
 *
 * Answers: 200 when the person is off the list — also when the entry was
 * already gone, since a second click has nothing left to do; 400 for a token
 * that is not ours; 503 when the entry's org is suspended and cannot be
 * entered, because the entry is still there and "you're off the list" would
 * be untrue.
 *
 * Rate limiting: the `/api/v1/waitlist` section cap, keyed on IP.
 */

import { NextRequest } from 'next/server';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { handleAPIError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { waitlistLeaveSchema } from '@/lib/validations/waitlist';
import { leaveWaitlist } from '@/lib/waitlist/confirm';

function invalidLink(): Response {
  return errorResponse('This link is not valid.', { code: 'INVALID_TOKEN', status: 400 });
}

export async function POST(request: NextRequest): Promise<Response> {
  const log = await getRouteLogger(request);
  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return invalidLink();
    }
    const parsed = waitlistLeaveSchema.safeParse(raw);
    if (!parsed.success) return invalidLink();

    const outcome = await leaveWaitlist(parsed.data.token);
    log.info('Waitlist leave handled', { outcome });
    if (outcome === 'invalid') return invalidLink();
    if (outcome === 'unavailable') {
      return errorResponse('This list is unavailable right now. Try again later.', {
        code: 'SERVICE_UNAVAILABLE',
        status: 503,
      });
    }
    return successResponse({ left: true });
  } catch (error) {
    return handleAPIError(error);
  }
}
