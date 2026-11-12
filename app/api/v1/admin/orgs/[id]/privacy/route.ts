/**
 * One org's LLM privacy settings (§127 t-1010)
 *
 * GET /api/v1/admin/orgs/[id]/privacy — the org's minimum privacy mode and
 *     the names it protects, and whether it has ever saved them.
 * PUT /api/v1/admin/orgs/[id]/privacy — replace them:
 *     `{ minimumMode: mode | null, protectedTerms: { value, type }[] }`.
 *     Both keys must be stated, so a replace cannot drop one by leaving it
 *     out.
 *
 * The minimum only ever tightens: every call made for the org runs under the
 * strictest of the install's mode, the agent's and this. Protected terms are
 * masked like the user's own name, by tier B. Both apply from the next chat
 * turn or workflow step; nothing caches them.
 *
 * A stored slice that cannot be read is reported (`unreadable: true`) with
 * what can still be read of it, rather than as empty: the privacy stage
 * refuses the org's every call until it is saved again, so the page has to
 * say why, and the save must not drop a floor that was there.
 *
 * Platform-only, like the provider policy beside it. Every replacement is in
 * the admin audit log with the mode it replaced and how many terms, never the
 * terms themselves: they are people's names, and the audit log is kept.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { OrgLifecycleError } from '@/lib/tenancy/lifecycle';
import {
  isSettingsWriteConflict,
  readOrgPrivacy,
  salvageOrgPrivacy,
  writeOrgPrivacy,
  type OrgPrivacyRead,
} from '@/lib/tenancy/org-settings';
import {
  orgIdParamSchema,
  orgPrivacySettingsSchema,
  type OrgPrivacySettings,
} from '@/lib/validations/tenancy';

const PLATFORM_ONLY = {
  // Ownership: no ownership decision — a vendor surface, platform admin only. See RouteOwnership in lib/auth/guards.ts.
  ownership: {
    decidedBy: 'nothing',
    because:
      'The vendor setting how one org’s AI calls are protected: the settings are the org’s, not any user’s, and the guard already limits this to platform admins.',
  },
} as const;

/**
 * The settings as the API reports them. An unreadable slice reports what can
 * still be read of it (`salvageOrgPrivacy`), so the save the page asks for
 * keeps a floor and the terms that parse rather than replace them with
 * nothing.
 */
function describe(orgId: string, read: OrgPrivacyRead, settings?: unknown) {
  if (!read.ok) {
    return { orgId, saved: true, unreadable: true, ...salvageOrgPrivacy(settings) };
  }
  return { orgId, saved: read.saved, unreadable: false, ...read.value };
}

/** What the audit log keeps: the mode, and how many terms. */
function auditable(read: OrgPrivacyRead | { ok: true; value: OrgPrivacySettings }) {
  if (!read.ok) return { unreadable: true };
  return {
    minimumMode: read.value.minimumMode,
    protectedTermCount: read.value.protectedTerms.length,
  };
}

export const GET = withAdminAuth<{ id: string }>(async (_request, _session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);

  const org = await prisma.org.findUnique({ where: { id }, select: { settings: true } });
  if (!org) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  return successResponse(describe(id, readOrgPrivacy(org.settings), org.settings));
}, PLATFORM_ONLY);

export const PUT = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  const body = await validateRequestBody(request, orgPrivacySettingsSchema);

  let written: Awaited<ReturnType<typeof writeOrgPrivacy>>;
  try {
    written = await writeOrgPrivacy(id, body);
  } catch (error) {
    if (!isSettingsWriteConflict(error)) throw error;
    // Another write to this org's settings landed between our read and ours.
    // Nothing was written; the caller re-reads and retries.
    return errorResponse(
      "Another change to this org's settings was saved at the same time; retry",
      { code: 'CONFLICT', status: 409 }
    );
  }
  if (!written) throw new OrgLifecycleError('ORG_NOT_FOUND', 'Organisation not found');

  logAdminAction({
    userId: session.user.id,
    action: 'org.privacy.replace',
    entityType: 'org',
    entityId: id,
    // The org changed, which a platform admin may do from outside it (t-1005).
    actingOrgId: id,
    changes: {
      privacy: {
        from: auditable(written.previous),
        to: auditable({ ok: true, value: written.stored }),
      },
    },
    clientIp: getClientIP(request),
  });

  log.info('Org privacy settings replaced by admin', {
    orgId: id,
    minimumMode: written.stored.minimumMode,
    protectedTermCount: written.stored.protectedTerms.length,
    actorUserId: session.user.id,
  });

  return successResponse(describe(id, { ok: true, saved: true, value: written.stored }));
}, PLATFORM_ONLY);
