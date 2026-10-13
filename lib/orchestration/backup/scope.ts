/**
 * Which org a backup reads or writes, and whether it carries the shared part
 * (§109 t-738).
 *
 * A backup has two parts:
 *
 *   • **the org's own part** — agents, workflows, webhook subscriptions. These
 *     are tenant-owned rows, read and written inside the target org.
 *   • **the shared part** — capabilities, knowledge tags and the `global`
 *     orchestration settings. One row serves every org (`GLOBAL_CONFIG_MODELS`),
 *     so writing it from one org changes it for all of them.
 *
 * **Target org.** Export and import run in an explicitly resolved org, not
 * whichever org the admin's session happens to be in: `?orgId=`, defaulting to
 * the active org. An unbound admin API key enters no org, so at `multi` it
 * must name one. Naming an org other than the active one asks the
 * authorization policy again, about THAT org — the route's own check only
 * asked whether the caller may use the admin surface at all.
 *
 * **Shared part** (owner ruling 2026-10-08, extending t-751's rule to export
 * as well as import). At `multi` it moves only when the caller asks for it
 * (`?shared=true`) and the CALLER is in the install org — the org its session
 * entered, as t-751's guard reads it, not the org named in `?orgId=` — or is
 * an unbound admin API key, which acts as the install org. Naming the install
 * org as the target does not count: an admin in a customer's org switches to
 * the install org to move the shared part, exactly as for any other shared
 * setting. A caller in a customer org that does not ask gets the target's own
 * part; one that asks is refused, and logged. Left unasked, the shared part is
 * included at `single` — one org, nothing to protect, so a single-tenant
 * install's backups are unchanged — and left out at `multi`.
 *
 * **A suspended org is not restored into.** Every other path treats it as
 * closed; an import naming one is refused. Its backup can still be exported.
 *
 * @see lib/tenancy/shared-settings.ts — the same rule for routes and capabilities
 * @see .context/orchestration/backup.md — the guide
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import {
  APIError,
  ConflictError,
  ErrorCodes,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/lib/api/errors';
import { canAdminister, type AuthorizationPrincipal } from '@/lib/auth/authorization';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import {
  canChangeSharedSettings,
  SHARED_SETTINGS_REFUSAL_CODE,
} from '@/lib/tenancy/shared-settings';
import { orgIdSchema } from '@/lib/validations/tenancy';

/** The query parameters both backup routes accept. */
export const backupScopeQuerySchema = z.object({
  /** The org to back up or restore into. Defaults to the active org. */
  orgId: orgIdSchema.optional(),
  /** Whether to carry the shared part. Defaults to yes at `single`, no at `multi`. */
  shared: z.enum(['true', 'false']).optional(),
});

export type BackupScopeQuery = z.infer<typeof backupScopeQuerySchema>;

/** The resolved scope a backup runs in. */
export interface BackupScope {
  /** The org whose own part is read or written. */
  orgId: string;
  /** Whether the shared part is exported or written. */
  includeShared: boolean;
}

/** The words on the refusal when a customer org asks for the shared part. */
export const BACKUP_SHARED_REFUSAL =
  'The shared part of a backup — capabilities, knowledge tags and the orchestration settings — ' +
  'applies to every organisation, so it can be exported or imported only from the install ' +
  'organisation. Switch to the install organisation, or leave out shared=true to back up ' +
  'only this organisation’s own part.';

/** What the backup does with the org, which decides whether a suspended org may be named. */
export type BackupPurpose = 'export' | 'import';

/**
 * Resolve the org and shared-part choice for a backup request.
 *
 * Call from inside the route guard: it reads the org the guard entered (none
 * for an unbound admin API key) as the active org.
 *
 * @throws {ValidationError} an unbound key at `multi` named no org, or a
 *   `single` install was asked for an org other than the install org
 * @throws {NotFoundError} the named org does not exist
 * @throws {ForbiddenError} the policy does not let the caller administer the named org
 * @throws {ConflictError} an import named a suspended org
 * @throws {APIError} 403 `shared_settings_install_org_only` — the shared part was asked
 *   for by a caller outside the install org
 */
export async function resolveBackupScope(
  query: BackupScopeQuery,
  principal: AuthorizationPrincipal,
  purpose: BackupPurpose
): Promise<BackupScope> {
  const multi = isMultiTenant();
  // The org the guard entered for this caller; none for an unbound admin key.
  const active = getTenantContext()?.orgId ?? null;
  // An admin API key is always unbound — the guard refuses a bound one — so
  // the credential alone says this caller entered no org.
  const unboundKey = principal.credential === 'api-key';

  let orgId: string;
  if (!multi) {
    if (query.orgId !== undefined && query.orgId !== INSTALL_ORG_ID) {
      throw new ValidationError(
        'This install has one organisation; orgId must name it or be left out.'
      );
    }
    orgId = INSTALL_ORG_ID;
  } else {
    const named = query.orgId ?? active;
    if (named === null) {
      throw new ValidationError(
        'An admin API key enters no organisation: name the organisation to back up with ?orgId=.'
      );
    }
    orgId = named;
    if (orgId !== active) {
      // The policy first: answering "no such org" or "suspended" before it
      // would tell a caller who may not administer the org whether it exists,
      // which the guard's own org entry refuses to do (`refuseOrgEntry`).
      const resource = { kind: 'org', id: orgId, orgId };
      if (!(await canAdminister(principal, resource, active ? { org: active } : {}))) {
        throw new ForbiddenError('You cannot administer that organisation');
      }
      // Org is a system model, so this read needs no tenant context.
      const org = await prisma.org.findUnique({ where: { id: orgId }, select: { status: true } });
      if (!org) throw new NotFoundError('Organisation not found');
      // A session can only be in an active org, so only a named one is checked.
      if (purpose === 'import' && org.status !== 'ACTIVE') {
        throw new ConflictError(
          'That organisation is suspended; a backup cannot be imported into it.'
        );
      }
    }
  }

  // t-751's rule, asked of the org this call stack entered. It refuses an
  // empty context, which is what an unbound admin key has — the guard admits
  // that key as the install org, and so does this.
  const sharedPermitted = unboundKey || canChangeSharedSettings();
  if (query.shared === 'true' && !sharedPermitted) {
    // The warning t-751's guard logs for the same refusal.
    logger.warn('tenancy: refused a backup’s shared part outside the install org', {
      purpose,
      userId: principal.userId,
      activeOrgId: active,
      targetOrgId: orgId,
    });
    throw new APIError(BACKUP_SHARED_REFUSAL, ErrorCodes.FORBIDDEN, 403, {
      reason: SHARED_SETTINGS_REFUSAL_CODE,
    });
  }
  const includeShared = query.shared === undefined ? !multi : query.shared === 'true';

  return { orgId, includeShared };
}
