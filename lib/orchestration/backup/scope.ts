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
 * (`?shared=true`) and the target is the install org, or the caller is an
 * unbound admin API key, which acts as the install org. A customer org that
 * does not ask gets its own part; one that asks is refused. Left unasked, it
 * is included at `single` — where there is one org and nothing to protect, so
 * a single-tenant install's backups are unchanged — and left out at `multi`.
 *
 * @see lib/tenancy/shared-settings.ts — the same rule for routes and capabilities
 * @see .context/orchestration/backup.md — the guide
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import {
  APIError,
  ErrorCodes,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/lib/api/errors';
import { canAdminister, type AuthorizationPrincipal } from '@/lib/auth/authorization';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { SHARED_SETTINGS_REFUSAL_CODE } from '@/lib/tenancy/shared-settings';
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
  'applies to every organisation, so it can be exported or imported only for the install ' +
  'organisation. Leave out shared=true to back up this organisation’s own part.';

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
 * @throws {APIError} 403 `shared_settings_install_org_only` — the shared part was asked
 *   for an org other than the install org
 */
export async function resolveBackupScope(
  query: BackupScopeQuery,
  principal: AuthorizationPrincipal
): Promise<BackupScope> {
  const multi = isMultiTenant();
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
    const active = getTenantContext()?.orgId ?? null;
    const named = query.orgId ?? active;
    if (named === null) {
      throw new ValidationError(
        'An admin API key enters no organisation: name the organisation to back up with ?orgId=.'
      );
    }
    orgId = named;
    if (orgId !== active) {
      // Org is a system model, so this read needs no tenant context.
      const org = await prisma.org.findUnique({ where: { id: orgId }, select: { id: true } });
      if (!org) throw new NotFoundError('Organisation not found');
      const resource = { kind: 'org', id: orgId, orgId };
      if (!(await canAdminister(principal, resource, active ? { org: active } : {}))) {
        throw new ForbiddenError('You cannot administer that organisation');
      }
    }
  }

  const sharedPermitted = !multi || unboundKey || orgId === INSTALL_ORG_ID;
  if (query.shared === 'true' && !sharedPermitted) {
    throw new APIError(BACKUP_SHARED_REFUSAL, ErrorCodes.FORBIDDEN, 403, {
      reason: SHARED_SETTINGS_REFUSAL_CODE,
    });
  }
  const includeShared = query.shared === undefined ? !multi : query.shared === 'true';

  return { orgId, includeShared };
}
