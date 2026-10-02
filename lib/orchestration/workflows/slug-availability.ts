/**
 * Workflow slug availability, across every org (§107 t-728).
 *
 * `AiWorkflow.slug` is unique across the whole install, not per org: it is
 * the inbound trigger URL's segment, so §107 kept it global. At
 * `TENANCY_MODE=multi` the `org_isolation` policy hides every other org's
 * workflows, so a plain `findUnique({ where: { slug } })` answers "free" for
 * a slug another org holds. The create then fails on the unique index, and
 * retrying fails the same way for ever.
 *
 * These probes ask the question under the system scope, the audited bypass,
 * and return only a yes/no answer or a free slug. No other org's row leaves
 * this module. A free slug of `base-3` does say that `base`, `base-1` and
 * `base-2` are held somewhere. That is no more than the caller could learn
 * already, one slug at a time: the unique index refuses a create on any of
 * them (the create route answers 409).
 *
 * `isWorkflowSlugTaken` is for the backup importer, which reads a slug in the
 * caller's org to decide between versioning and creating, and still has this
 * bug until §109 t-738 moves it onto this module.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import { runAsSystem } from '@/lib/tenancy/context';

/** True when any org's workflow holds `slug`. */
async function heldAnywhere(slug: string): Promise<boolean> {
  const row = await prisma.aiWorkflow.findUnique({ where: { slug }, select: { id: true } });
  return row !== null;
}

/**
 * Whether `slug` is held by a workflow in ANY org, the caller's or another's.
 *
 * To tell the caller's own row from another org's, read it as usual (the
 * tenancy chokepoint scopes that read to the caller's org) and ask this
 * only when that comes back empty.
 */
export function isWorkflowSlugTaken(slug: string): Promise<boolean> {
  return runAsSystem('workflow slug availability (global unique index)', () => heldAnywhere(slug));
}

/**
 * The longest workflow slug the API accepts: `createWorkflowSchema` and
 * `updateWorkflowSchema` both cap it at 100. A generated slug past it saves,
 * but the builder sends the slug back on every save and that PATCH fails.
 */
export const WORKFLOW_SLUG_MAX_LENGTH = 100;

/** `base` with `suffix`, cut so the whole fits the cap, and no hyphen left dangling. */
function fit(base: string, suffix: string): string {
  return base.slice(0, WORKFLOW_SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '') + suffix;
}

/**
 * The first of `base`, `base-1`, `base-2`, … that no org's workflow holds,
 * each cut to {@link WORKFLOW_SLUG_MAX_LENGTH} (the base is shortened, never
 * the suffix).
 *
 * A slug can still be taken between this answer and the caller's create, so
 * the caller keeps its P2002 handling.
 */
export function findFreeWorkflowSlug(base: string): Promise<string> {
  return runAsSystem('workflow slug availability (global unique index)', async () => {
    let slug = fit(base, '');
    for (let suffix = 1; await heldAnywhere(slug); suffix++) {
      slug = fit(base, `-${suffix}`);
    }
    return slug;
  });
}
