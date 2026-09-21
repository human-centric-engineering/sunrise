// First, and as a side-effect import: everything below validates the
// environment at import time, and imports are evaluated in order.
import '@/prisma/load-env';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from '@/lib/logging';
import { withTenancy } from '@/lib/db/tenancy-extension';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { getTenantContext, isMultiTenant, runAsOrg } from '@/lib/tenancy/context';
import { ownerDsn } from '@/lib/tenancy/isolation';
import { runSeeds } from '@/prisma/runner';

const { Pool } = pg;
// The owner DSN when there is one: at TENANCY_MODE=multi the app role is
// NOBYPASSRLS and does not own the tables (see
// .context/tenancy/isolation.md#the-role-split).
const pool = new Pool({ connectionString: ownerDsn() });
const adapter = new PrismaPg(pool);
// Through the chokepoint, and run as the install org: every tenant-owned row
// a seed creates is stamped with it, and at multi each write carries its
// setter — so the built-in agents, knowledge base and templates land as the
// install org's rather than as NULL-org rows no policy would ever show.
const prisma = withTenancy(new PrismaClient({ adapter }), {
  isMultiTenant,
  getTenantContext,
  installOrgId: INSTALL_ORG_ID,
});

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  logger.info('🌱 Seeding database...');
  await runAsOrg(INSTALL_ORG_ID, () => runSeeds(prisma, join(here, 'seeds')), { source: 'job' });
  logger.info('🎉 Seeding complete!');
}

main()
  .catch((e) => {
    logger.error('❌ Seeding failed', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
