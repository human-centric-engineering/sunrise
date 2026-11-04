/**
 * Admin Waitlist — counts (§125 t-976)
 *
 * GET /api/v1/admin/waitlist/counts — for each declared list: whether it is
 * open, how many entries are in each state, and the confirmed ones by source.
 * Unconfirmed and flagged entries are counted on their own lines, never
 * inside `confirmed`.
 *
 * Authentication: org admin (org-tier). 404 while the app has no waitlist.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { countWaitlistEntries } from '@/lib/waitlist/admin';
import { requireWaitlistConfig, WAITLIST_ADMIN_OWNERSHIP } from '@/lib/waitlist/admin-route';
import { toWaitlistFieldShape } from '@/lib/validations/waitlist';

export const GET = withAdminAuth(
  async () => {
    const config = requireWaitlistConfig();
    const lists = await countWaitlistEntries(config);
    // The declared fields ride along: the page labels the answer columns and
    // the search help from them, in one request.
    return successResponse({ lists, fields: config.fields.map(toWaitlistFieldShape) });
  },
  { tier: 'org', ownership: WAITLIST_ADMIN_OWNERSHIP }
);
