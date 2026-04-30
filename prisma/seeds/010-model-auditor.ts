import type { SeedUnit } from '@/prisma/runner';

const MODEL_AUDITOR_INSTRUCTIONS = `You are the Provider Model Auditor for the Sunrise AI orchestration platform. Your role is to evaluate provider model entries for accuracy and freshness, proposing corrections where data is stale or incorrect.

## Evaluation Criteria

For each model entry, assess:

1. **Tier role** — Is the classification correct given the model's capabilities?
   - thinking: deep reasoning, complex analysis
   - worker: general-purpose chat/completion
   - infrastructure: routing, classification, fast tasks
   - control_plane: orchestration, planning
   - local_sovereign: on-premise, privacy-focused
   - embedding: vector embeddings only

2. **Reasoning depth** — Does it match the model's actual capabilities?
3. **Latency** — Based on known provider performance characteristics
4. **Cost efficiency** — Relative to other models in the same tier
5. **Context length** — Current window size classification
6. **Tool use** — Actual function-calling capability level
7. **Best role** — One-line summary of optimal use case

For embedding models, also evaluate dimensions, quality rating, and schema compatibility.

## Output Format

Always respond with structured JSON when asked to analyse models. Use the ModelAuditResult format with specific, evidence-based reasons for every proposed change.

## Guidelines

- Only propose changes you are confident about. Use "low" confidence for uncertain assessments.
- Be specific in your reasoning — cite model capabilities, provider documentation, or known benchmarks.
- Never fabricate benchmark numbers. If unsure, say so.
- Treat the current data as correct unless you have clear evidence otherwise.`;

const APPLY_AUDIT_CHANGES_DEFINITION = {
  slug: 'apply_audit_changes',
  name: 'Apply Audit Changes',
  description:
    'Apply approved audit changes to a provider model entry. Validates each change against the update schema and invalidates the model cache.',
  category: 'internal',
  executionType: 'internal',
  executionHandler: 'ApplyAuditChangesCapability',
  functionDefinition: {
    name: 'apply_audit_changes',
    description:
      'Apply approved audit changes to provider model entries. Accepts a single model (model_id + changes) or multiple models (models array). Each change updates one auditable field after validation. Invalidates the model cache after all updates.',
    parameters: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: 'The ID of the provider model to update (single-model mode).',
          minLength: 1,
          maxLength: 100,
        },
        changes: {
          type: 'array',
          description: 'Array of approved field changes to apply (single-model mode).',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                enum: [
                  'tierRole',
                  'reasoningDepth',
                  'latency',
                  'costEfficiency',
                  'contextLength',
                  'toolUse',
                  'bestRole',
                  'description',
                  'dimensions',
                  'schemaCompatible',
                  'quality',
                ],
                description: 'The auditable field name to update.',
              },
              currentValue: {
                description: 'The current value of the field (for drift verification).',
              },
              proposedValue: {
                description: 'The new value to set.',
              },
              reason: {
                type: 'string',
                description: 'Why this change is being made.',
              },
              confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: 'How confident the audit is in this change.',
              },
            },
            required: ['field', 'currentValue', 'proposedValue', 'reason', 'confidence'],
          },
          minItems: 1,
          maxItems: 50,
        },
        models: {
          type: 'array',
          description:
            'Array of models to update (multi-model mode). Each entry has model_id and changes.',
          items: {
            type: 'object',
            properties: {
              model_id: { type: 'string' },
              changes: { type: 'array', items: { type: 'object' } },
            },
            required: ['model_id', 'changes'],
          },
          minItems: 1,
          maxItems: 50,
        },
      },
    },
  },
} as const;

/**
 * Seed the "provider-model-auditor" agent with the apply_audit_changes
 * capability. Also binds the existing search_knowledge_base and
 * estimate_workflow_cost capabilities.
 *
 * Idempotent — safe to run on every deploy. The `update` branch only
 * sets `isSystem: true` so re-seeding never overwrites admin edits.
 */
const unit: SeedUnit = {
  name: '010-model-auditor',
  async run({ prisma, logger }) {
    logger.info('🔍 Seeding provider-model-auditor agent...');

    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-test-users runs first.');
    }
    const createdBy = admin.id;

    // 1. Create the agent
    const agent = await prisma.aiAgent.upsert({
      where: { slug: 'provider-model-auditor' },
      update: { isSystem: true },
      create: {
        name: 'Provider Model Auditor',
        slug: 'provider-model-auditor',
        description:
          'Evaluates provider model entries for accuracy and freshness. Proposes changes for admin review via the audit workflow.',
        systemInstructions: MODEL_AUDITOR_INSTRUCTIONS,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        temperature: 0.2,
        maxTokens: 4096,
        monthlyBudgetUsd: 25,
        isActive: true,
        isSystem: true,
        createdBy,
      },
    });

    // 2. Upsert the apply_audit_changes capability
    const def = APPLY_AUDIT_CHANGES_DEFINITION;
    const auditCap = await prisma.aiCapability.upsert({
      where: { slug: def.slug },
      update: { isSystem: true },
      create: {
        name: def.name,
        slug: def.slug,
        description: def.description,
        category: def.category,
        functionDefinition: def.functionDefinition as unknown as object,
        executionType: def.executionType,
        executionHandler: def.executionHandler,
        isActive: true,
        isSystem: true,
      },
    });

    // 3. Bind apply_audit_changes to the agent
    await prisma.aiAgentCapability.upsert({
      where: {
        agentId_capabilityId: {
          agentId: agent.id,
          capabilityId: auditCap.id,
        },
      },
      update: {},
      create: {
        agentId: agent.id,
        capabilityId: auditCap.id,
        isEnabled: true,
      },
    });

    // 4. Bind existing built-in capabilities (search_knowledge_base, estimate_workflow_cost)
    const builtInSlugs = ['search_knowledge_base', 'estimate_workflow_cost'];
    for (const slug of builtInSlugs) {
      const cap = await prisma.aiCapability.findUnique({ where: { slug } });
      if (!cap) {
        logger.warn(`Built-in capability ${slug} not found — skipping binding`);
        continue;
      }
      await prisma.aiAgentCapability.upsert({
        where: {
          agentId_capabilityId: {
            agentId: agent.id,
            capabilityId: cap.id,
          },
        },
        update: {},
        create: {
          agentId: agent.id,
          capabilityId: cap.id,
          isEnabled: true,
        },
      });
    }

    logger.info('✅ Seeded provider-model-auditor agent with 3 capabilities');
  },
};

export default unit;
