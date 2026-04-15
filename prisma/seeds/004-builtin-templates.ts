import { BUILTIN_WORKFLOW_TEMPLATES } from '@/lib/orchestration/workflows/templates';
import type { SeedUnit } from '../runner';

/**
 * Upsert the built-in workflow templates (`BUILTIN_WORKFLOW_TEMPLATES`)
 * as `AiWorkflow` rows with `isTemplate: true`. Each row is keyed by the
 * template's static `slug`; the `update` branch is empty so re-running
 * the seeder against an admin-edited template row is a no-op.
 */
const unit: SeedUnit = {
  name: '004-builtin-templates',
  async run({ prisma, logger }) {
    logger.info('📚 Seeding built-in workflow templates...');

    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-test-users runs first.');
    }
    const createdBy = admin.id;

    for (const template of BUILTIN_WORKFLOW_TEMPLATES) {
      const patternsUsed = template.patterns.map((p) => p.number);
      await prisma.aiWorkflow.upsert({
        where: { slug: template.slug },
        update: {},
        create: {
          slug: template.slug,
          name: template.name,
          description: template.shortDescription,
          workflowDefinition: template.workflowDefinition as unknown as object,
          patternsUsed,
          isActive: true,
          isTemplate: true,
          createdBy,
        },
      });
    }

    logger.info(`✅ Upserted ${BUILTIN_WORKFLOW_TEMPLATES.length} built-in templates`);
  },
};

export default unit;
