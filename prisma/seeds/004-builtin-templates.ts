import { BUILTIN_WORKFLOW_TEMPLATES } from '@/prisma/seeds/data/templates';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Upsert the built-in workflow templates (`BUILTIN_WORKFLOW_TEMPLATES`)
 * as `AiWorkflow` rows with `isTemplate: true`. Each row is keyed by the
 * template's static `slug`; the `update` branch populates template-intrinsic
 * metadata (flowSummary, useCases, patterns) so re-seeding keeps it fresh.
 */
const unit: SeedUnit = {
  name: '004-builtin-templates',
  hashInputs: [
    './data/templates/index.ts',
    './data/templates/types.ts',
    './data/templates/code-review.ts',
    './data/templates/content-pipeline.ts',
    './data/templates/conversational-learning.ts',
    './data/templates/customer-support.ts',
    './data/templates/data-pipeline.ts',
    './data/templates/outreach-safety.ts',
    './data/templates/research-agent.ts',
    './data/templates/saas-backend.ts',
    './data/templates/autonomous-research.ts',
    './data/templates/cited-knowledge-advisor.ts',
    './data/templates/scheduled-source-monitor.ts',
  ],
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
      const templateMetadata = {
        flowSummary: template.flowSummary,
        useCases: template.useCases,
        patterns: template.patterns,
      };
      await prisma.aiWorkflow.upsert({
        where: { slug: template.slug },
        update: { metadata: templateMetadata as unknown as object },
        create: {
          slug: template.slug,
          name: template.name,
          description: template.shortDescription,
          workflowDefinition: template.workflowDefinition as unknown as object,
          patternsUsed,
          isActive: true,
          isTemplate: true,
          metadata: templateMetadata as unknown as object,
          createdBy,
        },
      });
    }

    logger.info(`✅ Upserted ${BUILTIN_WORKFLOW_TEMPLATES.length} built-in templates`);
  },
};

export default unit;
