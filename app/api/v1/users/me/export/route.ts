/**
 * Subject Access Export — self-service
 *
 * GET /api/v1/users/me/export - Download a copy of everything held about you
 *
 * The GDPR Art. 15 counterpart to `DELETE /api/v1/users/me`. Returns the whole
 * bundle assembled by `exportUserData()`; what it contains is decided by the
 * manifest in `lib/privacy/export-sources.ts`, not here.
 *
 * Authentication: Required, and a browser session specifically — see below.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { ErrorCodes } from '@/lib/api/errors';
import { withAuth } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { exportUserData } from '@/lib/privacy/export-user';
import { getRouteLogger } from '@/lib/api/context';
import { exportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

/**
 * GET /api/v1/users/me/export
 *
 * Returns every record the system holds about the calling user: their account,
 * sessions, linked sign-in methods, conversations and messages, agent memory,
 * evaluations, API key metadata, workflow runs, contact-form submissions, and
 * an index of the config they authored. Credential material — session tokens,
 * password hashes, OAuth tokens, API-key hashes, signing secrets — is omitted;
 * the bundle's own `meta` lists what was withheld and why.
 *
 * @returns The subject export bundle
 * @throws UnauthorizedError if not authenticated
 */
export const GET = withAuth(
  async (request, session) => {
    // An export is the entire account in one response, so it is exactly the kind
    // of request an API key should not be able to make. `withAuth` accepts a key
    // of ANY scope (see lib/auth/guards.ts), and keys are self-service — without
    // this check, a `chat`-scoped key pasted into a third-party integration or
    // left in a CI config would read out the owner's whole history. This mirrors
    // the identity-mutation refusal on `PATCH /api/v1/users/me`.
    if (isApiKeySession(session)) {
      const log = await getRouteLogger(request);
      log.warn('Rejected API-key attempt to export account data', { userId: session.user.id });
      return errorResponse('Exporting your data requires a browser session', {
        code: ErrorCodes.FORBIDDEN,
        status: 403,
      });
    }

    // Per-flow sub-cap on top of the section tier the proxy already applied.
    // A full export is an unbounded read across ~28 tables; the dedicated bucket
    // keeps a loop from turning one account into a database-wide scan.
    const rl = exportLimiter.check(`export:user:${session.user.id}`);
    if (!rl.success) return createRateLimitResponse(rl);

    const log = await getRouteLogger(request);
    log.info('Generating self-service subject data export');

    const bundle = await exportUserData({
      userId: session.user.id,
      actorUserId: session.user.id,
      reason: 'self_service',
    });

    return successResponse(bundle, undefined, {
      headers: {
        // A copy of someone's entire account has no business in a shared cache.
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="my-data-${session.user.id}.json"`,
      },
    });
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because:
        'Art. 15 subject access for the caller themselves — `exportUserData(session.user.id)`.',
    },
  }
);
