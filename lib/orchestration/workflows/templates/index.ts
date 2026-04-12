/**
 * Built-in workflow templates.
 *
 * Imported by both the admin builder toolbar (so the "Use template"
 * dropdown is zero-latency and offline) and `prisma/seed.ts` (so every
 * template is upserted as an `AiWorkflow` row with `isTemplate: true`).
 *
 * Adding a new template: create a new file, import it here, and append it
 * to `BUILTIN_WORKFLOW_TEMPLATES`. The seed is idempotent and the unit
 * test in `tests/unit/lib/orchestration/workflows/templates/index.test.ts`
 * will flag invalid DAGs on save.
 */

import { CONTENT_PIPELINE_TEMPLATE } from './content-pipeline';
import { CONVERSATIONAL_LEARNING_TEMPLATE } from './conversational-learning';
import { CUSTOMER_SUPPORT_TEMPLATE } from './customer-support';
import { RESEARCH_AGENT_TEMPLATE } from './research-agent';
import { SAAS_BACKEND_TEMPLATE } from './saas-backend';
import type { WorkflowTemplate } from './types';

export type { WorkflowTemplate, WorkflowTemplatePattern } from './types';

export const BUILTIN_WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  CUSTOMER_SUPPORT_TEMPLATE,
  CONTENT_PIPELINE_TEMPLATE,
  SAAS_BACKEND_TEMPLATE,
  RESEARCH_AGENT_TEMPLATE,
  CONVERSATIONAL_LEARNING_TEMPLATE,
];
