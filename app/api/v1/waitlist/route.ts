/**
 * Waitlist (public) — §125
 *
 * GET  /api/v1/waitlist — the declared lists and whether each is taking joins
 * POST /api/v1/waitlist — join a list
 *
 * Authentication: none. Both answer 404 until the app fills
 * `lib/app/waitlist-config.ts`.
 *
 * Rate limiting: the section cap (`/api/v1/waitlist`, keyed on IP) plus
 * `waitlistLimiter` on POST — 5 joins an hour per IP.
 *
 * **Every accepted join gets the same answer** — status, body and headers —
 * whether it created an entry, repeated one, hit the honeypot, was flagged by
 * the config's `screen()`, or re-joined a removed entry. Anything else tells a
 * stranger whether an address is on a pre-launch list. Response *time* still
 * differs a little between a create, an update and no write, and this does
 * not pad it; the confirmation mail (t-977) is to be sent in `after()` so the
 * larger difference stays off the response. The answers that do
 * differ say nothing about the address: a validation error (about the body),
 * a closed list (whether a list is open is public), and the rate limit (about
 * the caller).
 *
 * Entries land in the install org. At `multi` a fork's tenant resolver does not
 * route a public join to another org yet (§125 reconciliation, item 8).
 */

import { NextRequest } from 'next/server';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ErrorCodes, ValidationError, handleAPIError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import {
  createRateLimitResponse,
  getRateLimitHeaders,
  waitlistLimiter,
} from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';
import { isRecord } from '@/lib/utils';
import { buildWaitlistJoinSchema, toWaitlistFieldShape } from '@/lib/validations/waitlist';
import { getWaitlistConfig } from '@/lib/waitlist/config';
import { joinWaitlist } from '@/lib/waitlist/join';
import { getWaitlistListStatuses, isWaitlistListOpen } from '@/lib/waitlist/lists';
import { localeFromAcceptLanguage, referrerHost } from '@/lib/waitlist/provenance';

/** The one answer every accepted join gets. */
const JOINED_MESSAGE = 'Thanks for joining the waitlist.';

function notFound(): Response {
  return errorResponse('Not found', { code: ErrorCodes.NOT_FOUND, status: 404 });
}

/**
 * The honeypot is decided on its value, before validation: absent, `null` and
 * `''` are a person; anything else is a bot. Deciding it on a validation error
 * (the contact form's shape) turns `website: null` into "you're on the list"
 * with no row written.
 */
function hitHoneypot(body: Record<string, unknown>): boolean {
  const value = body.website;
  return value !== undefined && value !== null && value !== '';
}

/**
 * GET /api/v1/waitlist — `{ lists: [{ key, open }], fields: [...] }`: each
 * list's open state, so a page can show a closed list as closed before anyone
 * types into it, and the form's fields (`<Waitlist />` renders from this).
 */
export async function GET(): Promise<Response> {
  try {
    const config = getWaitlistConfig();
    if (!config) return notFound();
    const lists = await runAsOrg(INSTALL_ORG_ID, () => getWaitlistListStatuses(config), {
      source: 'public-form',
    });
    return successResponse({ lists, fields: config.fields.map(toWaitlistFieldShape) });
  } catch (error) {
    return handleAPIError(error);
  }
}

/**
 * POST /api/v1/waitlist
 *
 * Body: `{ email, name?, list?, details?: { <field key>: string }, utm_source?,
 * utm_medium?, utm_campaign?, referrer? }`. `list` may be omitted when the app
 * declares one list. `details` takes only the keys the config declares.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const config = getWaitlistConfig();
  if (!config) return notFound();

  const log = await getRouteLogger(request);
  try {
    const clientIP = getClientIP(request);
    const rateLimit = waitlistLimiter.check(clientIP);
    if (!rateLimit.success) {
      log.warn('Waitlist join rate limit exceeded', { ip: clientIP });
      return createRateLimitResponse(rateLimit);
    }
    const joined = () =>
      successResponse({ message: JOINED_MESSAGE }, undefined, {
        headers: getRateLimitHeaders(rateLimit),
      });

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ValidationError('Invalid JSON in request body');
    }
    if (!isRecord(raw)) throw new ValidationError('Invalid request body');

    if (hitHoneypot(raw)) {
      log.warn('Waitlist honeypot triggered', { ip: clientIP });
      return joined();
    }

    const { website: _honeypot, ...rest } = raw;
    const schema = buildWaitlistJoinSchema(
      config.fields,
      config.lists.map((l) => l.key)
    );
    const parsed = schema.safeParse(rest);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', {
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const body = parsed.data;

    const outcome = await runAsOrg(
      INSTALL_ORG_ID,
      async () => {
        if (!(await isWaitlistListOpen(config, body.list))) return 'closed' as const;
        return joinWaitlist(config, {
          email: body.email,
          name: body.name,
          list: body.list,
          details: body.details,
          source: 'form',
          locale: localeFromAcceptLanguage(request.headers.get('accept-language')),
          utmSource: body.utm_source,
          utmMedium: body.utm_medium,
          utmCampaign: body.utm_campaign,
          referrerHost: referrerHost(body.referrer),
          ip: clientIP,
        });
      },
      { source: 'public-form' }
    );

    if (outcome === 'closed') {
      return errorResponse('This waitlist is not taking new sign-ups right now.', {
        code: 'WAITLIST_CLOSED',
        status: 409,
        headers: getRateLimitHeaders(rateLimit),
      });
    }

    // The outcome and the list, never the address: this is a log of strangers.
    log.info('Waitlist join handled', { list: body.list, outcome });
    return joined();
  } catch (error) {
    return handleAPIError(error);
  }
}
