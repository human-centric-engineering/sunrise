/**
 * Admin Orchestration — Preview moving a model's uses (§136 t-1066)
 *
 * POST /api/v1/admin/orchestration/provider-models/:id/move-uses/preview
 *      Body: `{ replacementId }`. What moving every use of the model to the
 *      replacement would do, org by org, and to the install settings:
 *      `previewModelMove`. Changes nothing, and Sunrise sends nothing to a
 *      vendor (an org's own key is tested by the move itself, since the test
 *      is billed to that key). It asks the app's reporter and check, if the
 *      app registered them (§136 t-1067), the check with `phase: 'preview'`,
 *      so an app can answer from what it already knows rather than run
 *      anything billed. POST because it takes a body.
 *
 *      400 `VALIDATION_ERROR` (`replacementId`) when the replacement does not
 *      exist or does not qualify (`checkReplacement`: same provider, active,
 *      not itself retiring, every capability the model has).
 *
 * Authentication: platform admin. It reads every org's agents and workflows,
 * each inside that org's scope, and answers other orgs' uses as counts only.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { moveModelUsesSchema } from '@/lib/validations/orchestration';
import { loadMoveTarget, previewModelMove } from '@/lib/orchestration/model-lifecycle/move';

/** It walks every org, as the move does (`move-uses/route.ts`). */
export const maxDuration = 300;

export const POST = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'provider model id' });
  const body = await validateRequestBody(request, moveModelUsesSchema);

  const target = await loadMoveTarget(id, body.replacementId);
  const preview = await previewModelMove(target);

  log.info('Model move previewed', {
    providerModelId: id,
    replacementId: body.replacementId,
    orgs: preview.orgs.length,
    settings: preview.settings.moved.length,
  });
  return successResponse(preview);
});
