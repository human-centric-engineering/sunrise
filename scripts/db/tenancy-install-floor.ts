/**
 * Backfill the install-org membership on a single-tenant install (t-835).
 *
 *   npm run db:tenancy:install-floor
 *
 * Gives every user with no install-org membership one, by the platform-role
 * rule (`initialMembershipFor`). For accounts invited into another org before
 * #872's floor shipped, which otherwise lose everything when that org is
 * suspended. Idempotent: a second run reports "no change". Refuses at
 * `TENANCY_MODE=multi` and writes nothing, because there the install org is
 * the vendor's own.
 *
 * Exit codes: 0 done (or nothing to do), 2 failed: refused at `multi`, or a
 * database error. It writes in batches, so rows from batches before the error
 * stay written; re-running finishes the job, because it only adds what is
 * missing.
 *
 * @see lib/tenancy/membership.ts — backfillInstallMemberships
 * @see .context/tenancy/identity.md
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { backfillInstallMemberships } from '@/lib/tenancy/membership';

async function main(): Promise<void> {
  const { written } = await backfillInstallMemberships(prisma);
  logger.info(
    written === 0
      ? 'db:tenancy:install-floor: no change — every user is already a member of the install org'
      : `db:tenancy:install-floor: added ${written} install-org membership(s)`
  );
}

main()
  .then(async () => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`db:tenancy:install-floor failed: ${message}`);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(2);
  });
