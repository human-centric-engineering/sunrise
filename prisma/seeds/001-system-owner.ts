import { SYSTEM_USER_EMAIL } from '@/lib/auth/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds a single non-login SYSTEM config-owner user.
 *
 * Downstream orchestration seeds (workflows, capabilities, provider models,
 * judges, etc.) resolve an `ADMIN` user via
 * `prisma.user.findFirst({ where: { role: 'ADMIN' } })` and use its id as
 * `createdBy`. This unit guarantees such an owner exists on a fresh database.
 *
 * Deliberately NO credential `Account` is created — better-auth hashes
 * passwords with scrypt at signup, so a seeded credential cannot be made to
 * validate at login (see issue #278). This account therefore cannot log in;
 * it is purely a configuration owner. Real admins are bootstrapped by the
 * first-human-is-admin rule in `userCreateBeforeHook` (the first person to
 * sign up on a fresh database is promoted to `ADMIN`).
 */
const unit: SeedUnit = {
  name: '001-system-owner',
  async run({ prisma, logger }) {
    logger.info('👤 Creating system config-owner...');

    const systemUser = await prisma.user.upsert({
      where: { email: SYSTEM_USER_EMAIL },
      // `update` heals an existing row (e.g. an instance seeded before the
      // accountType field existed) so it is always marked SERVICE.
      update: { role: 'ADMIN', accountType: 'SERVICE' },
      create: {
        email: SYSTEM_USER_EMAIL,
        name: 'System (config owner)',
        emailVerified: true,
        role: 'ADMIN',
        accountType: 'SERVICE',
      },
    });

    logger.info('✅ Upserted system config-owner', { email: systemUser.email });
  },
};

export default unit;
