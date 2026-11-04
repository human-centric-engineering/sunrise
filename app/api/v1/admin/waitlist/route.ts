/**
 * Admin Waitlist — list (§125 t-976)
 *
 * GET /api/v1/admin/waitlist — one page of the org's entries.
 *
 * Query: `page`, `limit` (≤100, default 25), `sortBy` (`createdAt` |
 * `email` | `confirmedAt`), `sortOrder`, `list`, `q` (address, name or any
 * declared answer), `includeUnconfirmed`, `includeRemoved`, `includeJoined`,
 * `flaggedOnly`. By default only confirmed entries still on the list.
 *
 * Authentication: org admin (org-tier). 404 while the app has no waitlist.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { paginatedResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { waitlistAdminListQuerySchema } from '@/lib/validations/waitlist';
import { listWaitlistEntries } from '@/lib/waitlist/admin';
import { requireWaitlistConfig, WAITLIST_ADMIN_OWNERSHIP } from '@/lib/waitlist/admin-route';

export const GET = withAdminAuth(
  async (request) => {
    const config = requireWaitlistConfig();
    const query = validateQueryParams(request.nextUrl.searchParams, waitlistAdminListQuerySchema);
    const { entries, total } = await listWaitlistEntries(config, query);
    return paginatedResponse(entries, { page: query.page, limit: query.limit, total });
  },
  { tier: 'org', ownership: WAITLIST_ADMIN_OWNERSHIP }
);
