/**
 * An org's default interface language (§138 t-1071)
 *
 * PUT /api/v1/orgs/[id]/locale — `{ locale: string | null }`: set the language
 *     the org's members see when they have not chosen one of their own, or
 *     clear it (`null`) so they get their browser's. The locale must be one
 *     the interface has a catalogue for. Read it on `GET /api/v1/orgs/[id]`
 *     (`settings.locale`), which any member may call.
 *
 * Who may call it is the authorization policy's decision about the org the
 * URL names (`resolveOrgResource`): by default the org's OWNER and ADMIN
 * while they act in it. On top of that the caller must be acting in this org,
 * with a browser session: it is the org's own choice, so neither an API key
 * nor a support session sets it. A change is in the admin audit log as
 * `org.locale.update`.
 */

import type { NextRequest } from 'next/server';
import { withAuth, type AuthenticatedSession } from '@/lib/auth/guards';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { isSupportEntry } from '@/lib/auth/support-principal';
import { ForbiddenError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getTenantContext } from '@/lib/tenancy/context';
import { OrgLifecycleError, resolveOrgResource } from '@/lib/tenancy/lifecycle';
import { isSettingsWriteConflict, writeOrgLocale } from '@/lib/tenancy/org-settings';
import { orgIdParamSchema } from '@/lib/validations/tenancy';
import { localeChoiceBodySchema } from '@/lib/validations/locale';

const RESOURCE = {
  resource: async (_request: unknown, context?: { params: Promise<{ id: string }> }) =>
    resolveOrgResource(await context?.params),
  ownership: {
    decidedBy: 'resource',
    because:
      'The policy admitted the caller to the org the URL names; the handler writes that resolved org’s default language only.',
  },
} as const;

/**
 * Refuse a caller the policy admitted who may still not set the org's
 * language: an API key or a support session (it is the org's own choice),
 * or someone not acting in this org.
 */
function assertActsForOrg(session: AuthenticatedSession, orgId: string): void {
  if (isApiKeySession(session)) {
    throw new ForbiddenError('Changing an organisation’s language requires a browser session');
  }
  if (session.principal.orgId !== orgId) {
    throw new ForbiddenError('Switch to this organisation to change its language');
  }
  if (isSupportEntry(getTenantContext())) {
    throw new ForbiddenError('Support staff cannot change an organisation’s language');
  }
}

export const PUT = withAuth<{ id: string }>(async (request: NextRequest, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  assertActsForOrg(session, id);
  const { locale } = await validateRequestBody(request, localeChoiceBodySchema);

  let written: Awaited<ReturnType<typeof writeOrgLocale>>;
  try {
    written = await writeOrgLocale(id, locale);
  } catch (error) {
    if (!isSettingsWriteConflict(error)) throw error;
    return errorResponse(
      "Another change to this organisation's settings was saved at the same time; retry",
      { code: 'CONFLICT', status: 409 }
    );
  }
  if (!written) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  if (written.written) {
    logAdminAction({
      userId: session.user.id,
      action: 'org.locale.update',
      entityType: 'org',
      entityId: id,
      actingOrgId: id,
      changes: { locale: { from: written.previous, to: written.stored } },
      clientIp: getClientIP(request),
    });
    log.info('Org default locale changed', {
      orgId: id,
      locale: written.stored,
      actorUserId: session.user.id,
    });
  }

  return successResponse({ orgId: id, locale: written.stored });
}, RESOURCE);
