import type { SeedUnit } from '@/prisma/runner';

/**
 * Seed the `run_workflow` capability row.
 *
 * Adds the capability to the registry without binding it to any agent.
 * Bindings are created per-agent in the admin UI (or via API) — admins
 * must explicitly list the workflow slugs the LLM may invoke via
 * `customConfig.allowedWorkflowSlugs`. Off-by-default for every agent.
 *
 * Idempotent — safe to run on every deploy. The `update` branch only
 * sets `isSystem: true` so re-seeding never overwrites admin edits.
 */
const unit: SeedUnit = {
  name: '012-run-workflow',
  async run({ prisma, logger }) {
    logger.info('🔁 Seeding run_workflow capability...');

    await prisma.aiCapability.upsert({
      where: { slug: 'run_workflow' },
      update: { isSystem: true },
      create: {
        slug: 'run_workflow',
        name: 'Run Workflow',
        description:
          'Run a named workflow on behalf of the user during a chat turn. The workflow may pause for human approval, in which case an Approve / Reject card is rendered inline in the conversation.',
        category: 'orchestration',
        executionType: 'internal',
        executionHandler: 'RunWorkflowCapability',
        functionDefinition: {
          name: 'run_workflow',
          description:
            'Run a named workflow on behalf of the user. Use this for actions that require a multi-step pipeline, an approval gate, or capabilities not directly bound to this agent. The workflow may pause for human approval — when that happens, the user is shown an Approve / Reject card in the chat and the run continues only after they click. Returns when the workflow either completes (you receive the output) or pauses for approval (you receive a pending status; do not narrate further until the user replies).',
          parameters: {
            type: 'object',
            properties: {
              workflowSlug: {
                type: 'string',
                description:
                  'Slug of the workflow to run. Must be one of the workflows the admin has authorised this agent to invoke.',
                maxLength: 120,
              },
              input: {
                type: 'object',
                description:
                  "Input data passed to the workflow's entry step. Shape is defined by the workflow's expected input schema.",
                additionalProperties: true,
              },
            },
            required: ['workflowSlug'],
          },
        },
        rateLimit: 30,
        isActive: true,
        isSystem: true,
      },
    });

    logger.info('✅ Seeded run_workflow capability (no agent bindings — admin must opt-in)');
  },
};

export default unit;
