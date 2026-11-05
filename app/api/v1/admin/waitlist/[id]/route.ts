/**
 * Admin Waitlist — one entry (§125 t-976)
 *
 * PATCH  /api/v1/admin/waitlist/:id — `{ removed: boolean }`, the state to
 *   reach: remove the entry from the list (the row stays; Art. 15 still
 *   discloses it) or restore it. Idempotent under double clicks and two admins.
 *   Removing revokes any invitation the entry was sent (§125 t-978), so its
 *   link stops working; restoring sends nothing.
 * DELETE /api/v1/admin/waitlist/:id — erase it: delete the row, write a
 *   waitlist erasure receipt, and delete a pending invitation this org issued
 *   for the address (`eraseWaitlistEntry()`). A second DELETE is a 404: the
 *   verb never claims a deletion that did not happen.
 *
 * Neither the address nor the name is logged or audited: the entry id and its
 * list are.
 *
 * Authentication: org admin (org-tier). 404 while the app has no waitlist.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';
import { waitlistEntryPatchSchema } from '@/lib/validations/waitlist';
import { setWaitlistEntryRemoved } from '@/lib/waitlist/admin';
import { requireWaitlistConfig, WAITLIST_ADMIN_OWNERSHIP } from '@/lib/waitlist/admin-route';
import { eraseWaitlistEntry } from '@/lib/waitlist/erase';

type Params = { id: string };

async function entryId(params: Promise<Params>): Promise<string> {
  const parsed = cuidSchema.safeParse((await params).id);
  if (!parsed.success)
    throw new ValidationError('Invalid entry id', { id: ['Must be a valid CUID'] });
  return parsed.data;
}

export const PATCH = withAdminAuth<Params>(
  async (request, session, { params }) => {
    requireWaitlistConfig();
    const id = await entryId(params);
    const { removed } = await validateRequestBody(request, waitlistEntryPatchSchema);
    const log = await getRouteLogger(request);

    const result = await setWaitlistEntryRemoved(id, removed);
    if (!result) throw new NotFoundError('Waitlist entry not found');
    const { entry, changed, invitationsRevoked } = result;
    // Already in that state (a double click, a second admin): the answer is
    // the same, and nothing is recorded that did not happen.
    if (!changed) return successResponse(entry);

    logAdminAction({
      userId: session.user.id,
      action: removed ? 'waitlist_entry.remove' : 'waitlist_entry.restore',
      entityType: 'waitlist_entry',
      entityId: id,
      entityName: entry.list,
      ...(removed ? { metadata: { invitationsRevoked } } : {}),
      clientIp: getClientIP(request),
    });
    log.info('Waitlist entry updated', {
      recordId: id,
      list: entry.list,
      removed,
      invitationsRevoked,
    });
    return successResponse(entry);
  },
  { tier: 'org', ownership: WAITLIST_ADMIN_OWNERSHIP }
);

export const DELETE = withAdminAuth<Params>(
  async (request, session, { params }) => {
    requireWaitlistConfig();
    const id = await entryId(params);
    const log = await getRouteLogger(request);

    const receipt = await eraseWaitlistEntry({
      entryId: id,
      actorUserId: session.user.id,
      reason: 'admin_action',
    });
    if (!receipt) throw new NotFoundError('Waitlist entry not found');

    logAdminAction({
      userId: session.user.id,
      action: 'waitlist_entry.erase',
      entityType: 'waitlist_entry',
      entityId: id,
      entityName: null,
      metadata: { receiptId: receipt.receiptId, invitationsDeleted: receipt.invitationsDeleted },
      clientIp: getClientIP(request),
    });
    log.info('Waitlist entry erased', {
      recordId: id,
      receiptId: receipt.receiptId,
      invitationsDeleted: receipt.invitationsDeleted,
    });
    return successResponse({
      erased: true,
      receiptId: receipt.receiptId,
      erasedAt: receipt.erasedAt,
      invitationsDeleted: receipt.invitationsDeleted,
    });
  },
  { tier: 'org', ownership: WAITLIST_ADMIN_OWNERSHIP }
);
