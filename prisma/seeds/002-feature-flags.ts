import { DEFAULT_FLAGS } from '@/lib/feature-flags/config';
import type { SeedUnit } from '../runner';

const unit: SeedUnit = {
  name: '002-feature-flags',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding feature flags...');

    for (const flag of DEFAULT_FLAGS) {
      await prisma.featureFlag.upsert({
        where: { name: flag.name },
        update: {},
        create: {
          name: flag.name,
          description: flag.description,
          enabled: flag.enabled,
          metadata: flag.metadata,
        },
      });
    }

    logger.info(`✅ Upserted ${DEFAULT_FLAGS.length} feature flags`);
  },
};

export default unit;
