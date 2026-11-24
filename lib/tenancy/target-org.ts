/**
 * The org an admin route acts on when the caller may name one (`?orgId=`).
 *
 * Most admin routes act on the org the guard entered. A few let the caller
 * name another, so a platform admin in the install org can do per-org vendor
 * work without entering the customer's org with platform standing, which
 * #1177 removed: backup export and import (§109 t-738), and force-failing a
 * run or bulk-clearing conversations (t-1083).
 *
 * The rule, in {@link resolveTargetOrg}:
 *
 *   - **Nothing named:** the org the guard entered, as before.
 *   - **At `single`:** only the install org may be named.
 *   - **At `multi`, an org other than the entered one:** the authorization
 *     policy is asked again, about THAT org. The route's own check only asked
 *     whether the caller may use the surface at all. Then the org must exist.
 *
 * {@link runInTargetOrg} runs the work there: unchanged when the target is the
 * entered org, so a session's own context (its role, a support stamp) is kept;
 * inside `runAsOrg(target)` otherwise, so every read and write lands in the
 * named org whatever org the caller is in.
 *
 * @see lib/orchestration/backup/scope.ts — backup's use, with its shared part
 * @see .context/tenancy/context.md — the scopes
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { canAdminister, type AuthorizationPrincipal } from '@/lib/auth/authorization';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import {
  getTenantContext,
  isMultiTenant,
  runAsOrg,
  type TenantContextSource,
} from '@/lib/tenancy/context';
import { orgIdSchema } from '@/lib/validations/tenancy';

/** A source {@link runInTargetOrg} may carry into another org. */
type CarriedSource = Exclude<TenantContextSource, 'system' | 'implicit' | 'support'>;

/**
 * Whether {@link runInTargetOrg} carries `source` into another org. Not the
 * system and implicit scopes (no org was entered), nor `support`, whose stamp
 * is consent for the entered org only.
 */
function isCarried(source: TenantContextSource): source is CarriedSource {
  return source !== 'system' && source !== 'implicit' && source !== 'support';
}

/** The query a route that takes a target org accepts. */
export const targetOrgQuerySchema = z.object({
  /** The org to act on. Defaults to the org the guard entered. */
  orgId: orgIdSchema.optional(),
});

export interface ResolveTargetOrgOptions {
  /**
   * The refusal when nothing is named and the caller entered no org: an
   * unbound admin API key at `multi`. Says what the route would have done.
   */
  noOrgMessage: string;
  /**
   * Refuse a suspended org with this message (409). Left out, a suspended org
   * may be named: unsticking its runs or exporting its backup is work on an org
   * that is closed to its own members, not a way back in.
   */
  suspendedMessage?: string;
}

/**
 * Resolve the org a request acts on. Call from inside the route guard: it
 * reads the org the guard entered (none for an unbound admin API key).
 *
 * @throws {ValidationError} an unbound key at `multi` named no org, or a
 *   `single` install was asked for an org other than the install org
 * @throws {ForbiddenError} the policy does not let the caller administer the named org
 * @throws {NotFoundError} the named org does not exist
 * @throws {ConflictError} the named org is suspended and `suspendedMessage` was given
 */
export async function resolveTargetOrg(
  named: string | undefined,
  principal: AuthorizationPrincipal,
  options: ResolveTargetOrgOptions
): Promise<string> {
  if (!isMultiTenant()) {
    if (named !== undefined && named !== INSTALL_ORG_ID) {
      throw new ValidationError(
        'This install has one organisation; orgId must name it or be left out.'
      );
    }
    return INSTALL_ORG_ID;
  }

  // The org the guard entered for this caller; none for an unbound admin key.
  const active = getTenantContext()?.orgId ?? null;
  const orgId = named ?? active;
  if (orgId === null) throw new ValidationError(options.noOrgMessage);
  if (orgId === active) return orgId;

  // The policy first: answering "no such org" or "suspended" before it would
  // tell a caller who may not administer the org whether it exists, which the
  // guard's own org entry refuses to do (`refuseOrgEntry`).
  const resource = { kind: 'org', id: orgId, orgId };
  if (!(await canAdminister(principal, resource, active ? { org: active } : {}))) {
    throw new ForbiddenError('You cannot administer that organisation');
  }
  // Org is a system model, so this read needs no tenant context.
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { status: true } });
  if (!org) throw new NotFoundError('Organisation not found');
  // A session can only be in an active org, so only a named one is checked.
  if (options.suspendedMessage !== undefined && org.status !== 'ACTIVE') {
    throw new ConflictError(options.suspendedMessage);
  }
  return orgId;
}

/**
 * Run `fn` in `orgId`: as it is when that is the org the call stack already
 * runs in, inside `runAsOrg(orgId)` when it is another.
 *
 * In another org the caller's source is kept (a session, an admin API key), so
 * what reads the context sees an admin's request, not a background job. The
 * role is not: it is the caller's role in the org they entered, and they hold
 * none in the target. Nor is a support entry, which is consent for the org the
 * caller entered, so a `support` source is not carried either. An unbound
 * admin key runs in no org and has no source worth keeping. Those take
 * `runAsOrg`'s default.
 */
export function runInTargetOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = getTenantContext();
  const active = ctx?.orgId ?? null;
  if (!isMultiTenant() || orgId === active) return fn();
  const source = ctx && isCarried(ctx.source) ? ctx.source : undefined;
  return runAsOrg(orgId, fn, source ? { source } : {});
}
