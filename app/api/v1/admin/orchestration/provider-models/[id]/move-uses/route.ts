/**
 * Admin Orchestration — Move a model's uses to its replacement (§136 t-1066)
 *
 * POST /api/v1/admin/orchestration/provider-models/:id/move-uses
 *      Body: `{ replacementId }`. Moves every use of the model to the
 *      replacement on the same provider. First the app's check, when it
 *      registered one (§136 t-1067: `lib/app/model-pins.ts`); then every org's own key for the
 *      provider is tested against the replacement (an org whose test fails is
 *      skipped); then the install's settings pins (left when any key failed);
 *      then each active org's agents (a new version each) and workflows (the
 *      draft, and a new published version), one org at a time in its own scope
 *      and transaction.
 *      `moveModelUses` documents the rules.
 *
 *      200 with every org's outcome (`moved`, `skipped` or `failed`, with a
 *      reason), what was left and why, and the totals. An org failing does not
 *      fail the request: its changes roll back and the rest still move.
 *
 *      400 `VALIDATION_ERROR` (`replacementId`) when the replacement does not
 *      exist or does not qualify, a model on another provider included.
 *
 *      409 `CONFLICT` (`details.refusedBy: 'app'`) when the app's check
 *      refuses the move, with its reason, before anything is tested or
 *      written. A check that throws, times out or answers badly refuses too.
 *
 *      The 300 seconds below cover the app's reports and check as well as the
 *      walk over the orgs, so a long check leaves less for the walk.
 *
 * Authentication: platform admin, from the install org (it writes the
 * install settings, `writesSharedSettings`). Every change is in the admin
 * audit log: a row per agent and workflow in its org, one for the settings,
 * and a summary row for the move.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { moveModelUsesSchema } from '@/lib/validations/orchestration';
import { loadMoveTarget, moveModelUses } from '@/lib/orchestration/model-lifecycle/move';

/**
 * The move walks every org in one request, testing an own-key org's key on
 * the way, so it can outlast a default function timeout. An org that finished
 * has committed; a request cut off leaves the rest for a second run.
 */
export const maxDuration = 300;

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const id = validatePathParam(rawId, cuidSchema, { label: 'provider model id' });
    const body = await validateRequestBody(request, moveModelUsesSchema);

    const target = await loadMoveTarget(id, body.replacementId);
    const result = await moveModelUses(target, {
      userId: session.user.id,
      clientIp: getClientIP(request),
    });

    log.info('Model uses moved', {
      providerModelId: id,
      replacementId: body.replacementId,
      adminId: session.user.id,
      ...result.totals,
    });
    return successResponse(result);
  },
  { writesSharedSettings: true }
);
