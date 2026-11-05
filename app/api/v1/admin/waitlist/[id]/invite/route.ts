/**
 * Admin Waitlist — invite one entry (§125 t-978)
 *
 * POST /api/v1/admin/waitlist/:id/invite — no body. Sends a Sunrise invitation
 * to the entry's address, as `USER` into this org, carrying the entry's id so
 * the sign-up that redeems it links the entry to the account. Re-sends (a new
 * link) when this entry's own invitation is still pending.
 *
 * Responds 201 `{ entry, outcome: 'invited' | 'resent', emailStatus, expiresAt }`.
 * No link: an org admin's invitation reaches the invitee by email only, as on
 * `POST /api/v1/orgs/:id/invitations` — the token is all acceptance asks for.
 * A failed email is `emailStatus: 'failed'`, and Resend sends another.
 *
 * Refuses 404 for an entry not in this org; 409 `{ reason }` for a removed,
 * joined, unconfirmed or flagged entry, an address with an account, someone
 * else's pending invitation, or an entry that changed meanwhile; 429 from
 * `inviteLimiter` on the admin's IP, the bound every single-invitation route
 * shares (a wave has its own, `waitlistInviteWaveLimiter`).
 *
 * This route logs and audits the entry id and the outcome, never the address.
 * The platform's invitation delivery, which every invite route shares, logs
 * the address it issues to and emails.
 *
 * Authentication: org admin (org-tier). 404 while the app has no waitlist.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse, inviteLimiter } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';
import { requireWaitlistConfig, WAITLIST_ADMIN_OWNERSHIP } from '@/lib/waitlist/admin-route';
import { inviteWaitlistEntry } from '@/lib/waitlist/invite';
import { WAITLIST_INVITE_REFUSAL_MESSAGES } from '@/lib/waitlist/invite-refusals';

type Params = { id: string };

export const POST = withAdminAuth<Params>(
  async (request, session, { params }) => {
    requireWaitlistConfig();
    const log = await getRouteLogger(request);

    // First, before any read: the email-bombing bound the platform's invite
    // routes apply, and the one refusal that costs no database round trip.
    const clientIp = getClientIP(request);
    const limit = inviteLimiter.check(clientIp);
    if (!limit.success) {
      log.warn('Waitlist invite rate limit exceeded', { adminId: session.user.id });
      return createRateLimitResponse(limit);
    }

    const parsed = cuidSchema.safeParse((await params).id);
    if (!parsed.success) {
      throw new ValidationError('Invalid entry id', { id: ['Must be a valid CUID'] });
    }
    const id = parsed.data;

    const result = await inviteWaitlistEntry({
      entryId: id,
      inviter: { id: session.user.id, name: session.user.name },
      log,
    });

    if (result.outcome === 'refused') {
      if (result.reason === 'not_found') throw new NotFoundError('Waitlist entry not found');
      log.info('Waitlist invite refused', { recordId: id, reason: result.reason });
      throw new ConflictError(WAITLIST_INVITE_REFUSAL_MESSAGES[result.reason], {
        reason: result.reason,
      });
    }

    logAdminAction({
      userId: session.user.id,
      action: result.outcome === 'resent' ? 'waitlist_entry.reinvite' : 'waitlist_entry.invite',
      entityType: 'waitlist_entry',
      entityId: id,
      entityName: result.entry.list,
      metadata: { emailStatus: result.emailStatus },
      clientIp,
    });
    log.info(
      result.outcome === 'resent' ? 'Waitlist invitation resent' : 'Waitlist invitation sent',
      {
        recordId: id,
        list: result.entry.list,
        emailStatus: result.emailStatus,
      }
    );

    return successResponse(
      {
        entry: result.entry,
        outcome: result.outcome,
        emailStatus: result.emailStatus,
        expiresAt: result.expiresAt.toISOString(),
      },
      undefined,
      { status: 201 }
    );
  },
  { tier: 'org', ownership: WAITLIST_ADMIN_OWNERSHIP }
);
