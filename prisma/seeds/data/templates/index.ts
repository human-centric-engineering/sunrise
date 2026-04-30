/**
 * Built-in workflow templates — seed data.
 *
 * Consumed by `prisma/seeds/004-builtin-templates.ts` which upserts each
 * template as an `AiWorkflow` row with `isTemplate: true`. The UI reads
 * templates via the workflows API, not from this module.
 *
 * Adding a new template: create a new file, import it here, and append it
 * to `BUILTIN_WORKFLOW_TEMPLATES`. The seed is idempotent and the unit
 * test in `tests/unit/lib/orchestration/workflows/templates/index.test.ts`
 * will flag invalid DAGs on save.
 */

import { AUTONOMOUS_RESEARCH_TEMPLATE } from '@/prisma/seeds/data/templates/autonomous-research';
import { CODE_REVIEW_TEMPLATE } from '@/prisma/seeds/data/templates/code-review';
import { CONTENT_PIPELINE_TEMPLATE } from '@/prisma/seeds/data/templates/content-pipeline';
import { CONVERSATIONAL_LEARNING_TEMPLATE } from '@/prisma/seeds/data/templates/conversational-learning';
import { CUSTOMER_SUPPORT_TEMPLATE } from '@/prisma/seeds/data/templates/customer-support';
import { DATA_PIPELINE_TEMPLATE } from '@/prisma/seeds/data/templates/data-pipeline';
import { OUTREACH_SAFETY_TEMPLATE } from '@/prisma/seeds/data/templates/outreach-safety';
import { RESEARCH_AGENT_TEMPLATE } from '@/prisma/seeds/data/templates/research-agent';
import { SAAS_BACKEND_TEMPLATE } from '@/prisma/seeds/data/templates/saas-backend';
import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export type {
  WorkflowTemplate,
  WorkflowTemplatePattern,
  WorkflowTemplateUseCase,
} from '@/prisma/seeds/data/templates/types';

export const BUILTIN_WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  CUSTOMER_SUPPORT_TEMPLATE,
  CONTENT_PIPELINE_TEMPLATE,
  SAAS_BACKEND_TEMPLATE,
  RESEARCH_AGENT_TEMPLATE,
  CONVERSATIONAL_LEARNING_TEMPLATE,
  DATA_PIPELINE_TEMPLATE,
  OUTREACH_SAFETY_TEMPLATE,
  CODE_REVIEW_TEMPLATE,
  AUTONOMOUS_RESEARCH_TEMPLATE,
];
