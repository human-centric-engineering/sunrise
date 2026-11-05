/**
 * Admin Waitlist — invite a wave (§125 t-978, decision 7)
 *
 * POST /api/v1/admin/waitlist/invite — one of:
 *   `{ mode: 'ids', ids }`                       the rows the admin ticked
 *   `{ mode: 'next', count, list?, answer? }`    the next `count` by join date
 *   `{ mode: 'sample', count, list?, answer? }`  `count` chosen at random
 * `next` and `sample` draw from entries that can be invited and have not been,
 * narrowed to one list and/or one answer (`{ field, value }`) when given.
 * At most `WAITLIST_INVITE_WAVE_MAX` (50) a wave.
 *
 * Each chosen entry is invited as `POST /api/v1/admin/waitlist/:id/invite`
 * would, in turn; one refused or failing never stops the rest. Responds 200
 * `{ selected, invited, refused, failed, emailNotSent, rows: [{ id, outcome,
 * reason?, emailStatus? }] }`. A wave that chose nobody is `selected: 0`.
 *
 * Its own cap: `waitlistInviteWaveLimiter`, 5 waves an hour per admin. Not
 * `inviteLimiter`, which counts single invitations per IP and would stop a
 * wave a tenth of the way through. A wave is counted only once its body is
 * valid and it chose someone: a malformed request or a filter that matches
 * nobody does not use one up.
 *
 * This route logs and audits counts and ids, never an address. The platform's
 * invitation delivery, which every invite route shares, logs the address it
 * issues to and emails.
 *
 * Authentication: org admin (org-tier). 404 while the app has no waitlist.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse, waitlistInviteWaveLimiter } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { waitlistInviteWaveSchema } from '@/lib/validations/waitlist';
import { requireWaitlistConfig, WAITLIST_ADMIN_OWNERSHIP } from '@/lib/waitlist/admin-route';
import { inviteWaitlistWave, selectWaveEntries } from '@/lib/waitlist/invite';

export const POST = withAdminAuth(
  async (request, session) => {
    const config = requireWaitlistConfig();
    const log = await getRouteLogger(request);

    const body = await validateRequestBody(request, waitlistInviteWaveSchema);
    const ids = await selectWaveEntries(config, body);

    // Spent only on a wave that will send something.
    if (ids.length > 0) {
      const limit = waitlistInviteWaveLimiter.check(`waitlist-wave:user:${session.user.id}`);
      if (!limit.success) {
        log.warn('Waitlist invite wave rate limit exceeded', { adminId: session.user.id });
        return createRateLimitResponse(limit);
      }
    }

    const result = await inviteWaitlistWave({
      ids,
      inviter: { id: session.user.id, name: session.user.name },
      log,
    });

    if (result.selected > 0) {
      logAdminAction({
        userId: session.user.id,
        action: 'waitlist.invite_wave',
        entityType: 'waitlist_entry',
        entityId: null,
        entityName: body.mode === 'ids' ? null : (body.list ?? null),
        metadata: {
          mode: body.mode,
          selected: result.selected,
          invited: result.invited,
          refused: result.refused,
          failed: result.failed,
          emailNotSent: result.emailNotSent,
          invitedIds: result.rows
            .filter((r) => r.outcome === 'invited' || r.outcome === 'resent')
            .map((r) => r.id),
        },
        clientIp: getClientIP(request),
      });
    }
    log.info('Waitlist invite wave', {
      mode: body.mode,
      selected: result.selected,
      invited: result.invited,
      refused: result.refused,
      failed: result.failed,
      emailNotSent: result.emailNotSent,
    });

    return successResponse(result);
  },
  { tier: 'org', ownership: WAITLIST_ADMIN_OWNERSHIP }
);
