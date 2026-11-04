/**
 * Admin Waitlist — open or close a list (§125 t-976)
 *
 * PATCH /api/v1/admin/waitlist/lists/:key — `{ open: boolean }`, the state to
 * reach, for one list the config declares. Records who and when; from then on
 * the stored state beats the config's starting state. Closing stops new joins
 * and nothing else: confirming, leaving, invites, export and erasure go on.
 *
 * Authentication: org admin (org-tier). 404 while the app has no waitlist, and
 * for a key the config does not declare.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { waitlistListKeySchema, waitlistListPatchSchema } from '@/lib/validations/waitlist';
import { setWaitlistListOpen } from '@/lib/waitlist/admin';
import { requireWaitlistConfig, WAITLIST_ADMIN_OWNERSHIP } from '@/lib/waitlist/admin-route';

type Params = { key: string };

export const PATCH = withAdminAuth<Params>(
  async (request, session, { params }) => {
    const config = requireWaitlistConfig();
    const parsed = waitlistListKeySchema.safeParse((await params).key);
    if (!parsed.success || !config.lists.some((l) => l.key === parsed.data)) {
      throw new NotFoundError('Waitlist list not found');
    }
    const key = parsed.data;
    const { open } = await validateRequestBody(request, waitlistListPatchSchema);
    const log = await getRouteLogger(request);

    const state = await setWaitlistListOpen(key, open, session.user.id);

    logAdminAction({
      userId: session.user.id,
      action: open ? 'waitlist_list.open' : 'waitlist_list.close',
      entityType: 'waitlist_list',
      entityId: key,
      entityName: key,
      clientIp: getClientIP(request),
    });
    log.info('Waitlist list state set', { list: key, open });
    return successResponse(state);
  },
  { tier: 'org', ownership: WAITLIST_ADMIN_OWNERSHIP }
);
