import { PROVIDER_MODEL_AUDIT_TEMPLATE } from '@/prisma/seeds/data/templates/provider-model-audit';
import { Prisma } from '@prisma/client';
import { createInitialVersion } from '@/lib/orchestration/workflows/version-service';
import type { SeedUnit } from '@/prisma/runner';
import { CAPABILITIES } from '@/lib/orchestration/model-audit/enums';
import { serviceAccountWhere } from '@/lib/auth/account';

export const APPLY_AUDIT_CHANGES_DEFINITION = {
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
                  'deploymentProfiles',
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
              model_id: {
                type: 'string',
              },
              changes: {
                type: 'array',
                items: {
                  type: 'object',
                },
              },
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

export const ADD_PROVIDER_MODELS_DEFINITION = {
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
              name: {
                type: 'string',
                description: 'Human-readable model name.',
              },
              slug: {
                type: 'string',
                description: 'URL-safe slug (lowercase alphanumeric with hyphens).',
              },
              providerSlug: {
                type: 'string',
                description: 'Provider identifier.',
              },
              modelId: {
                type: 'string',
                description: 'API model identifier.',
              },
              description: {
                type: 'string',
                description: 'Brief model description.',
              },
              capabilities: {
                type: 'array',
                items: {
                  type: 'string',
                  // Sourced, not spelled out: a hard-coded literal here drifted
                  // in the past and made `validate_proposals` reject any
                  // proposal containing 'vision' or 'documents'. This is the
                  // constant the capability CLASS reads — note that is
                  // `model-audit/enums`, not the same-valued `MODEL_CAPABILITIES`
                  // in `types/orchestration` that this seed used to import.
                  enum: [...CAPABILITIES],
                },
                description: 'Model capabilities.',
              },
              tierRole: {
                type: 'string',
                enum: ['thinking', 'worker', 'infrastructure', 'control_plane', 'embedding'],
                description:
                  'Capability tier classification \u2014 what the model is for. Orthogonal to deploymentProfiles (where it runs).',
              },
              deploymentProfiles: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['hosted', 'sovereign'],
                },
                description:
                  'Deployment locus \u2014 where the model runs. `hosted` is vendor-managed; `sovereign` is operator infrastructure. Defaults to ["hosted"].',
              },
              reasoningDepth: {
                type: 'string',
                enum: ['very_high', 'high', 'medium', 'none'],
              },
              latency: {
                type: 'string',
                enum: ['very_fast', 'fast', 'medium'],
              },
              costEfficiency: {
                type: 'string',
                enum: ['very_high', 'high', 'medium', 'none'],
              },
              contextLength: {
                type: 'string',
                enum: ['very_high', 'high', 'medium', 'n_a'],
              },
              toolUse: {
                type: 'string',
                enum: ['strong', 'moderate', 'none'],
              },
              bestRole: {
                type: 'string',
                description: 'Optimal use case summary.',
              },
              dimensions: {
                type: 'number',
                description: 'Embedding vector dimensions.',
              },
              schemaCompatible: {
                type: 'boolean',
                description: 'Compatible with pgvector(1536) schema.',
              },
              quality: {
                type: 'string',
                enum: ['high', 'medium', 'budget'],
              },
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

export const DEACTIVATE_PROVIDER_MODELS_DEFINITION = {
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
 * Seed the provider-model audit's capabilities (`apply_audit_changes`,
 * `add_provider_models`, `deactivate_provider_models`) and its system
 * workflow.
 *
 * The two agents the workflow runs — `provider-model-auditor` and
 * `audit-report-writer` — are platform agents now (§116 t-724), defined in
 * `lib/orchestration/agents/platform-agent-definitions/model-auditor.ts` and
 * materialised in the install org only by `021-platform-agents`, which also
 * owns their bindings. The workflow stays the install org's: it writes the
 * provider-model catalogue every org reads.
 *
 * Idempotent — safe to run on every deploy. The audit template is in
 * `hashInputs` so any edit to the template file invalidates the unit's
 * content hash and forces a re-run.
 *
 * The `aiWorkflow` write rewrites `workflowDefinition`, `metadata`,
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
    logger.info('🔍 Seeding provider-model audit capabilities and workflow...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }
    const createdBy = admin.id;

    // 1. Upsert the apply_audit_changes capability
    const def = APPLY_AUDIT_CHANGES_DEFINITION;
    await prisma.aiCapability.upsert({
      where: { slug: def.slug },
      // Code-owned fields are re-applied so an edited definition reaches rows
      // that already exist; `name` / `description` / `category` / `isActive`
      // stay operator-owned. See `.context/database/seeding.md` (#545).
      update: {
        isSystem: true,
        executionType: def.executionType,
        executionHandler: def.executionHandler,
        functionDefinition: def.functionDefinition,
      },
      create: {
        name: def.name,
        slug: def.slug,
        description: def.description,
        category: def.category,
        functionDefinition: def.functionDefinition,
        executionType: def.executionType,
        executionHandler: def.executionHandler,
        isActive: true,
        isSystem: true,
      },
    });

    // 2. Upsert the add_provider_models capability
    const addDef = ADD_PROVIDER_MODELS_DEFINITION;
    await prisma.aiCapability.upsert({
      where: { slug: addDef.slug },
      // Code-owned fields are re-applied so an edited definition reaches rows
      // that already exist; `name` / `description` / `category` / `isActive`
      // stay operator-owned. See `.context/database/seeding.md` (#545).
      update: {
        isSystem: true,
        executionType: addDef.executionType,
        executionHandler: addDef.executionHandler,
        functionDefinition: addDef.functionDefinition,
      },
      create: {
        name: addDef.name,
        slug: addDef.slug,
        description: addDef.description,
        category: addDef.category,
        functionDefinition: addDef.functionDefinition,
        executionType: addDef.executionType,
        executionHandler: addDef.executionHandler,
        isActive: true,
        isSystem: true,
      },
    });

    // 3. Upsert the deactivate_provider_models capability
    const deactDef = DEACTIVATE_PROVIDER_MODELS_DEFINITION;
    await prisma.aiCapability.upsert({
      where: { slug: deactDef.slug },
      // Code-owned fields are re-applied so an edited definition reaches rows
      // that already exist; `name` / `description` / `category` / `isActive`
      // stay operator-owned. See `.context/database/seeding.md` (#545).
      update: {
        isSystem: true,
        executionType: deactDef.executionType,
        executionHandler: deactDef.executionHandler,
        functionDefinition: deactDef.functionDefinition,
      },
      create: {
        name: deactDef.name,
        slug: deactDef.slug,
        description: deactDef.description,
        category: deactDef.category,
        functionDefinition: deactDef.functionDefinition,
        executionType: deactDef.executionType,
        executionHandler: deactDef.executionHandler,
        isActive: true,
        isSystem: true,
      },
    });

    // 4. Upsert the Provider Model Audit workflow as a system workflow.
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
            snapshot: tpl.workflowDefinition as unknown as Prisma.InputJsonValue,
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

    logger.info('✅ Seeded 3 provider-model audit capabilities + system workflow');
  },
};

export default unit;
