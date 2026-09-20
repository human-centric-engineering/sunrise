import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from '@/lib/logging';
import { runSeeds } from '@/prisma/runner';

const { Pool } = pg;
// The owner DSN when there is one: at TENANCY_MODE=multi the app role is
// NOBYPASSRLS and the seed writes tenant-owned rows outside any org context
// (see .context/tenancy/isolation.md#the-role-split).
const pool = new Pool({
  connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  logger.info('🌱 Seeding database...');
  await runSeeds(prisma, join(here, 'seeds'));
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
