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
 * and return only whether the slug is taken. No other org's row leaves this
 * module. The slug's existence is no secret from the caller: the unique index
 * would refuse the create anyway.
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
 * The first of `base`, `base-1`, `base-2`, … that no org's workflow holds.
 *
 * A slug can still be taken between this answer and the caller's create, so
 * the caller keeps its P2002 handling.
 */
export function findFreeWorkflowSlug(base: string): Promise<string> {
  return runAsSystem('workflow slug availability (global unique index)', async () => {
    let slug = base;
    for (let suffix = 1; await heldAnywhere(slug); suffix++) {
      slug = `${base}-${suffix}`;
    }
    return slug;
  });
}
