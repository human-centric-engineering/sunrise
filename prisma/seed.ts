import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { logger } from '../lib/logging';
import { DEFAULT_FLAGS } from '../lib/feature-flags/config';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

async function main() {
  logger.info('🌱 Seeding database...');

  // Clear existing data (in development only)
  if (process.env.NODE_ENV === 'development') {
    logger.info('🗑️  Clearing existing data...');
    await prisma.verification.deleteMany();
    await prisma.session.deleteMany();
    await prisma.account.deleteMany();
    await prisma.user.deleteMany();
    await prisma.featureFlag.deleteMany();
  }

  // Create test users
  logger.info('👤 Creating test users...');

  const testUser = await prisma.user.create({
    data: {
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: true,
      role: 'USER',
    },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@example.com',
      name: 'Admin User',
      emailVerified: true,
      role: 'ADMIN',
    },
  });

  logger.info('✅ Created test user', { email: testUser.email });
  logger.info('✅ Created admin user', { email: adminUser.email });

  // Seed default feature flags
  logger.info('🚩 Seeding feature flags...');

  for (const flag of DEFAULT_FLAGS) {
    const createdFlag = await prisma.featureFlag.create({
      data: {
        name: flag.name,
        description: flag.description,
        enabled: flag.enabled,
        metadata: flag.metadata,
      },
    });
    logger.info('✅ Created feature flag', { name: createdFlag.name });
  }

  logger.info('🎉 Seeding complete!');
}

main()
  .catch((e) => {
    logger.error('❌ Seeding failed', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
