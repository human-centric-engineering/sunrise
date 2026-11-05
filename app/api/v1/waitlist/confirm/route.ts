/**
 * Waitlist — confirm an address (§125 t-977)
 *
 * POST /api/v1/waitlist/confirm — `{ entry, token }`, from the button on the
 * page the confirmation email links to (`/waitlist/confirm`). Opening the link
 * alone confirms nothing: mail scanners open links before people do.
 *
 * Authentication: none — the token is the credential. It is single use and
 * expires after seven days. **A wrong, expired, used or malformed token, and
 * an entry that is gone, all get the same 400**, so the route cannot be used
 * to learn which entries exist or which links were clicked.
 *
 * Works whether or not the list is open (closing stops new joins only).
 * Answers 404 when the app has no waitlist.
 *
 * Rate limiting: the `/api/v1/waitlist` section cap, keyed on IP. A token is
 * 32 random bytes, so the cap bounds load, not guessing.
 */

import { NextRequest } from 'next/server';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ErrorCodes, handleAPIError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { waitlistConfirmSchema } from '@/lib/validations/waitlist';
import { getWaitlistConfig } from '@/lib/waitlist/config';
import { confirmWaitlistEntry } from '@/lib/waitlist/confirm';

/** The one answer for every link that cannot confirm. */
function invalidLink(): Response {
  return errorResponse('This link has expired or has already been used.', {
    code: 'INVALID_TOKEN',
    status: 400,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!getWaitlistConfig()) {
    return errorResponse('Not found', { code: ErrorCodes.NOT_FOUND, status: 404 });
  }
  const log = await getRouteLogger(request);
  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return invalidLink();
    }
    const parsed = waitlistConfirmSchema.safeParse(raw);
    if (!parsed.success) return invalidLink();

    const outcome = await confirmWaitlistEntry(parsed.data.entry, parsed.data.token);
    // The outcome only: the entry id is in the link, and the link is a secret.
    log.info('Waitlist confirm handled', { outcome });
    if (outcome !== 'confirmed') return invalidLink();
    return successResponse({ confirmed: true });
  } catch (error) {
    return handleAPIError(error);
  }
}
