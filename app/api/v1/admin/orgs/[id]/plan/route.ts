/**
 * One org's billing plan, assigned by hand (§139 t-1093)
 *
 * GET   /api/v1/admin/orgs/[id]/plan — whether plans apply on this install,
 *       the plans the app registers (and what each decides), its fallback
 *       plan, the org's subscription record, and whether this caller may
 *       change it.
 * PATCH /api/v1/admin/orgs/[id]/plan — `{ planKey: string | null }`: put the
 *       org on that plan and write what the plan decides to its switches,
 *       meter limits and AI budget; `null` takes it off its hand-assigned
 *       plan and leaves those as they are.
 *
 * Plans apply only at `TENANCY_MODE=multi` with at least one plan registered
 * (`billingPlansEnabled()`); otherwise a PATCH is a 409 saying billing is
 * off, and GET says `enabled: false`. No payment provider is needed.
 *
 * Platform-only, with the refusals the entitlements and meters routes have:
 * at `multi` a platform admin switched into a customer's org may read the plan
 * but not change it (`mayChangeOrgCommercialSettings`). An org that pays
 * through a provider is refused (409, `PROVIDER_MANAGED`): its plan follows
 * that subscription. Every assignment that changes something is in the admin
 * audit log (`org.plan.assign`) with what it replaced; re-assigning a plan
 * that is fully applied writes nothing.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { APIError, ErrorCodes } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  billingPlansEnabled,
  billingPlansFailed,
  fallbackPlan,
  registeredPlans,
} from '@/lib/billing/plans';
import { assignPlan, BillingPlanError, loadOrgSubscription } from '@/lib/billing/subscriptions';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import { isSettingsWriteConflict } from '@/lib/tenancy/org-settings';
import {
  mayChangeOrgCommercialSettings,
  SHARED_SETTINGS_REFUSAL_CODE,
} from '@/lib/tenancy/shared-settings';
import { orgIdParamSchema, orgPlanInputSchema } from '@/lib/validations/tenancy';
import { prisma } from '@/lib/db/client';

const PLATFORM_ONLY = {
  // Ownership: no ownership decision — a vendor surface, platform admin only. See RouteOwnership in lib/auth/guards.ts.
  ownership: {
    decidedBy: 'nothing',
    because:
      'The vendor deciding which plan one org is on: the plan is the org’s, not any user’s, and the guard already limits this to platform admins.',
  },
} as const;

/** The words an admin sees when a customer org's context tries to change it. */
const PLAN_REFUSAL =
  "An organisation's plan can only be changed from the install organisation. Switch to the install organisation to make this change.";

/** The plan as the API reports it; `null` when there is no such org. */
async function describe(orgId: string, mayChange: boolean) {
  // `Org` is a system model, so this read needs no tenant scope.
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return null;
  return {
    orgId,
    enabled: billingPlansEnabled(),
    multiTenant: isMultiTenant(),
    registrationFailed: billingPlansFailed(),
    mayChange,
    plans: registeredPlans().map((plan) => ({
      key: plan.key,
      label: plan.label,
      description: plan.description,
      priced: plan.priceLookupKey !== null,
      switches: plan.switches,
      meterLimits: plan.meterLimits,
      aiBudgetUsd: plan.aiBudgetUsd ?? null,
      decidesAiBudget: plan.aiBudgetUsd !== undefined,
    })),
    fallbackPlanKey: fallbackPlan()?.key ?? null,
    subscription: await loadOrgSubscription(orgId),
  };
}

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const described = await describe(
    id,
    mayChangeOrgCommercialSettings(session.principal.credential)
  );
  if (!described) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
  return successResponse(described);
}, PLATFORM_ONLY);

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  // Asked before the body is read, so a caller who may not write is told
  // where to go rather than how to fix a request it cannot make.
  if (!mayChangeOrgCommercialSettings(session.principal.credential)) {
    log.warn('billing: refused an org plan assignment outside the install org', {
      orgId: id,
      actorUserId: session.user.id,
      activeOrgId: getTenantContext()?.orgId ?? null,
    });
    throw new APIError(PLAN_REFUSAL, ErrorCodes.FORBIDDEN, 403, {
      reason: SHARED_SETTINGS_REFUSAL_CODE,
    });
  }

  const { planKey } = await validateRequestBody(request, orgPlanInputSchema);

  let result: Awaited<ReturnType<typeof assignPlan>>;
  try {
    result = await assignPlan(id, planKey);
  } catch (error) {
    if (error instanceof BillingPlanError) {
      switch (error.code) {
        case 'ORG_NOT_FOUND':
          throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
        case 'UNKNOWN_PLAN':
          // A VALIDATION_ERROR's details are fields (lib/api/errors.ts).
          return errorResponse(error.message, {
            code: 'VALIDATION_ERROR',
            status: 400,
            details: { errors: [{ path: 'planKey', message: error.message }] },
          });
        case 'BILLING_OFF':
          return errorResponse(error.message, {
            code: 'CONFLICT',
            status: 409,
            details: { reason: 'billing_off' },
          });
        case 'PROVIDER_MANAGED':
          return errorResponse(error.message, {
            code: 'CONFLICT',
            status: 409,
            details: { reason: 'provider_managed' },
          });
      }
    }
    if (!isSettingsWriteConflict(error)) throw error;
    // Another write to this org's settings landed between our read and ours.
    // The record may name the plan with it not yet applied; assigning it
    // again finishes the write.
    return errorResponse(
      "Another change to this org's settings was saved at the same time; assign the plan again",
      { code: 'CONFLICT', status: 409 }
    );
  }

  // An assignment that changed nothing wrote nothing, and is not a change to record.
  if (result.changed) {
    const applied = result.applied;
    logAdminAction({
      userId: session.user.id,
      action: 'org.plan.assign',
      entityType: 'org',
      entityId: id,
      // The org changed, which a platform admin may do from outside it (t-1005).
      actingOrgId: id,
      changes: {
        plan: { from: result.previousPlanKey, to: result.planKey },
        ...(applied?.switches ? { switches: applied.switches } : {}),
        ...(applied?.meterLimits ? { meterLimits: applied.meterLimits } : {}),
        ...(applied?.aiBudgetUsd ? { monthlyBudgetUsd: applied.aiBudgetUsd } : {}),
      },
      clientIp: getClientIP(request),
    });

    log.info('Org plan assigned by admin', {
      orgId: id,
      from: result.previousPlanKey,
      to: result.planKey,
      actorUserId: session.user.id,
    });
  }

  // Refused above otherwise, so this caller may change it.
  const described = await describe(id, true);
  if (!described) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');
  return successResponse(described);
}, PLATFORM_ONLY);
