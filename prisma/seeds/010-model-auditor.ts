import { PROVIDER_MODEL_AUDIT_TEMPLATE } from '@/prisma/seeds/data/templates/provider-model-audit';
import { createInitialVersion } from '@/lib/orchestration/workflows/version-service';
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

const REPORT_WRITER_INSTRUCTIONS = `You are the Audit Report Writer for the Sunrise AI orchestration platform. Your role is to synthesise structured audit data into clear, human-readable executive reports.

## Report Structure

Every report you produce should follow this structure:

1. **Executive Summary** — One paragraph overview: what was audited, how many models were reviewed, and the key outcomes (changes made, new models added, deactivations).

2. **Changes Applied** — List each field change grouped by provider, including model name, field, old value, new value, and the reason. Use a table format where possible.

3. **New Models Added** — List each newly registered model with its name, provider, tier role, key capabilities, and best role.

4. **Models Deactivated** — List each deactivated model with the provider and reason for deactivation.

5. **Quality Assessment** — Summarise the audit quality scores (accuracy, completeness, specificity, confidence calibration, consistency). Note any areas that scored below threshold.

6. **Recommendations** — Actionable follow-up items: models needing manual review, providers with many changes (suggesting rapid evolution), fields with low-confidence changes that an admin should verify.

## Guidelines

- Be specific — always cite model names, provider slugs, and field values.
- Keep the tone professional and concise. Admins reading this report are technical.
- If a section has no items (e.g. no deactivations), say so briefly rather than omitting the section.
- Format numbers and counts clearly. If zero changes were applied, state that explicitly.
- Do not editorialize or speculate beyond what the data shows.`;

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

const ADD_PROVIDER_MODELS_DEFINITION = {
  slug: 'add_provider_models',
  name: 'Add Provider Models',
  description:
    'Add new provider model entries to the registry from approved audit proposals. Validates each model, skips duplicates, and invalidates the model cache.',
  category: 'internal',
  executionType: 'internal',
  executionHandler: 'AddProviderModelsCapability',
  functionDefinition: {
    name: 'add_provider_models',
    description:
      'Add new provider model entries to the registry. Each model is validated against the create schema. Duplicate slugs are skipped. Invalidates the model cache after all creates.',
    parameters: {
      type: 'object',
      properties: {
        newModels: {
          type: 'array',
          description: 'Array of new model entries to create.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Human-readable model name.' },
              slug: {
                type: 'string',
                description: 'URL-safe slug (lowercase alphanumeric with hyphens).',
              },
              providerSlug: { type: 'string', description: 'Provider identifier.' },
              modelId: { type: 'string', description: 'API model identifier.' },
              description: { type: 'string', description: 'Brief model description.' },
              capabilities: {
                type: 'array',
                items: { type: 'string', enum: ['chat', 'embedding'] },
              },
              tierRole: {
                type: 'string',
                enum: [
                  'thinking',
                  'worker',
                  'infrastructure',
                  'control_plane',
                  'local_sovereign',
                  'embedding',
                ],
              },
              reasoningDepth: {
                type: 'string',
                enum: ['very_high', 'high', 'medium', 'none'],
              },
              latency: { type: 'string', enum: ['very_fast', 'fast', 'medium'] },
              costEfficiency: {
                type: 'string',
                enum: ['very_high', 'high', 'medium', 'none'],
              },
              contextLength: {
                type: 'string',
                enum: ['very_high', 'high', 'medium', 'n_a'],
              },
              toolUse: { type: 'string', enum: ['strong', 'moderate', 'none'] },
              bestRole: { type: 'string', description: 'Optimal use case summary.' },
              dimensions: { type: 'number' },
              schemaCompatible: { type: 'boolean' },
              quality: { type: 'string', enum: ['high', 'medium', 'budget'] },
            },
            required: [
              'name',
              'slug',
              'providerSlug',
              'modelId',
              'description',
              'capabilities',
              'tierRole',
              'bestRole',
            ],
          },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ['newModels'],
    },
  },
} as const;

const DEACTIVATE_PROVIDER_MODELS_DEFINITION = {
  slug: 'deactivate_provider_models',
  name: 'Deactivate Provider Models',
  description:
    'Soft-delete provider model entries that have been deprecated or discontinued. Sets isActive=false after admin approval.',
  category: 'internal',
  executionType: 'internal',
  executionHandler: 'DeactivateProviderModelsCapability',
  functionDefinition: {
    name: 'deactivate_provider_models',
    description:
      'Deactivate (soft-delete) provider model entries that have been deprecated or discontinued. Sets isActive=false. Already-inactive models are skipped.',
    parameters: {
      type: 'object',
      properties: {
        deactivateModels: {
          type: 'array',
          description: 'Array of models to deactivate.',
          items: {
            type: 'object',
            properties: {
              modelId: {
                type: 'string',
                description: 'The ID of the provider model to deactivate.',
              },
              reason: {
                type: 'string',
                description:
                  'Why this model should be deactivated (e.g. "Model deprecated by provider on 2026-03-01").',
              },
            },
            required: ['modelId', 'reason'],
          },
          minItems: 1,
          maxItems: 50,
        },
      },
      required: ['deactivateModels'],
    },
  },
} as const;

/**
 * Seed the "provider-model-auditor" agent with the apply_audit_changes,
 * add_provider_models, and deactivate_provider_models capabilities.
 * Also binds the existing search_knowledge_base and
 * estimate_workflow_cost capabilities.
 *
 * Idempotent — safe to run on every deploy. The audit template is in
 * `hashInputs` so any edit to the template file invalidates the unit's
 * content hash and forces a re-run.
 *
 * The `aiWorkflow.upsert` rewrites `workflowDefinition`, `metadata`,
 * `name`, `description`, and `patternsUsed` on every re-seed because
 * the audit workflow is a SYSTEM workflow (framework-managed). Admin
 * edits to system workflows are not preserved — admins should clone
 * the workflow if they want a custom variant. Templates (seeded by
 * `004-builtin-templates`) follow the opposite convention and only
 * write on initial create.
 */
const unit: SeedUnit = {
  name: '010-model-auditor',
  hashInputs: ['data/templates/provider-model-audit.ts'],
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

    // 3. Upsert the add_provider_models capability
    const addDef = ADD_PROVIDER_MODELS_DEFINITION;
    const addCap = await prisma.aiCapability.upsert({
      where: { slug: addDef.slug },
      update: { isSystem: true },
      create: {
        name: addDef.name,
        slug: addDef.slug,
        description: addDef.description,
        category: addDef.category,
        functionDefinition: addDef.functionDefinition as unknown as object,
        executionType: addDef.executionType,
        executionHandler: addDef.executionHandler,
        isActive: true,
        isSystem: true,
      },
    });

    // 4. Upsert the deactivate_provider_models capability
    const deactDef = DEACTIVATE_PROVIDER_MODELS_DEFINITION;
    const deactCap = await prisma.aiCapability.upsert({
      where: { slug: deactDef.slug },
      update: { isSystem: true },
      create: {
        name: deactDef.name,
        slug: deactDef.slug,
        description: deactDef.description,
        category: deactDef.category,
        functionDefinition: deactDef.functionDefinition as unknown as object,
        executionType: deactDef.executionType,
        executionHandler: deactDef.executionHandler,
        isActive: true,
        isSystem: true,
      },
    });

    // 5. Bind all audit capabilities to the agent
    for (const cap of [auditCap, addCap, deactCap]) {
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

    // 6. Bind existing built-in capabilities (search_knowledge_base, estimate_workflow_cost)
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

    // 7. Create the audit-report-writer agent (no capabilities — pure synthesis)
    await prisma.aiAgent.upsert({
      where: { slug: 'audit-report-writer' },
      update: { isSystem: true },
      create: {
        name: 'Audit Report Writer',
        slug: 'audit-report-writer',
        description:
          'Synthesises provider model audit results into a consolidated human-readable report with recommendations.',
        systemInstructions: REPORT_WRITER_INSTRUCTIONS,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        temperature: 0.3,
        maxTokens: 4096,
        isActive: true,
        isSystem: true,
        createdBy,
      },
    });

    // 8. Upsert the Provider Model Audit workflow as a system workflow.
    // System workflows are framework-managed: every re-seed rewrites the
    // definition + metadata to track the code. Admin edits are not
    // preserved — clone the workflow to customise.
    const tpl = PROVIDER_MODEL_AUDIT_TEMPLATE;
    const patternsUsed = tpl.patterns.map((p) => p.number);
    const metadata = {
      flowSummary: tpl.flowSummary,
      useCases: tpl.useCases,
      patterns: tpl.patterns,
    } as unknown as object;
    // System workflows are framework-managed: every re-seed promotes the
    // current template definition to a new version, so the audit chain is
    // intact across upgrades and admins can compare today's behaviour with
    // any prior seed.
    await prisma.$transaction(async (tx) => {
      const existing = await tx.aiWorkflow.findUnique({
        where: { slug: tpl.slug },
        select: { id: true, publishedVersionId: true },
      });
      if (existing) {
        const lastVersion = await tx.aiWorkflowVersion.findFirst({
          where: { workflowId: existing.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const newVersion = await tx.aiWorkflowVersion.create({
          data: {
            workflowId: existing.id,
            version: (lastVersion?.version ?? 0) + 1,
            snapshot: tpl.workflowDefinition as unknown as object,
            changeSummary: 'Seeded by 010-model-auditor',
            createdBy,
          },
        });
        await tx.aiWorkflow.update({
          where: { id: existing.id },
          data: {
            name: tpl.name,
            description: tpl.shortDescription,
            patternsUsed,
            metadata,
            isSystem: true,
            isTemplate: false,
            publishedVersionId: newVersion.id,
          },
        });
      } else {
        const created = await tx.aiWorkflow.create({
          data: {
            slug: tpl.slug,
            name: tpl.name,
            description: tpl.shortDescription,
            patternsUsed,
            isActive: true,
            isTemplate: false,
            isSystem: true,
            metadata,
            createdBy,
          },
        });
        await createInitialVersion({
          tx,
          workflowId: created.id,
          definition: tpl.workflowDefinition,
          userId: createdBy,
        });
      }
    });

    logger.info(
      '✅ Seeded provider-model-auditor + audit-report-writer agents with 5 capabilities + system workflow'
    );
  },
};

export default unit;
