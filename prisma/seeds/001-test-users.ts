import type { SeedUnit } from '@/prisma/runner';

const unit: SeedUnit = {
  name: '001-test-users',
  async run({ prisma, logger }) {
    logger.info('👤 Creating test users...');

    const testUser = await prisma.user.upsert({
      where: { email: 'test@example.com' },
      update: {},
      create: {
        email: 'test@example.com',
        name: 'Test User',
        emailVerified: true,
        role: 'USER',
      },
    });

    const adminUser = await prisma.user.upsert({
      where: { email: 'admin@example.com' },
      update: {},
      create: {
        email: 'admin@example.com',
        name: 'Admin User',
        emailVerified: true,
        role: 'ADMIN',
      },
    });

    logger.info('✅ Upserted test user', { email: testUser.email });
    logger.info('✅ Upserted admin user', { email: adminUser.email });
  },
};

export default unit;
