/**
 * `audit-proposals` — Zod schema for the structural shape produced by
 * the three audit-workflow producers (`analyse_chat`,
 * `analyse_embedding`, `discover_new_models`).
 *
 * The schema is consumed by the `validate_proposals` guard step in
 * `prisma/seeds/data/templates/provider-model-audit.ts` (mode:
 * 'schema', inputStepIds: ['analyse_chat', 'analyse_embedding',
 * 'discover_new_models']).
 *
 * Replaces the prior LLM-mode validator's structural rules (Rules
 * 1–9 of the previous prompt). The remaining subjective rule — Rule
 * 10, "the change reason must engage with currentValue" — stays on
 * a downstream LLM-mode `validate_rationale` guard. LLM judgement
 * is the right tool for "is this sentence on-topic for this field";
 * LLM judgement is the wrong tool for "is `vision` in this six-
 * element array."
 *
 * Every enum is imported from `lib/orchestration/model-audit/enums`
 * so the schema cannot drift from the apply-side validation
 * (`apply-audit-changes` capability uses the same constants). The
 * AUDITABLE_FIELDS list comes from the capability itself for the
 * same reason — one source of truth per closed set.
 *
 * Module side effect: `registerSchema('audit-proposals', ...)` runs
 * at module load. The schemas barrel
 * (`lib/orchestration/schemas/index.ts`) imports this file so the
 * registration fires once per Node process whenever the engine
 * loads the guard executor.
 */

import { z } from 'zod';

import { registerSchema } from '@/lib/orchestration/schemas/registry';
import {
  CAPABILITIES,
  CONFIDENCE,
  CONTEXT_LENGTH,
  COST_EFFICIENCY,
  DEPLOYMENT_PROFILES,
  LATENCY,
  QUALITY,
  REASONING_DEPTH,
  TIER_ROLES,
  TOOL_USE,
} from '@/lib/orchestration/model-audit/enums';
import { AUDITABLE_FIELDS } from '@/lib/orchestration/capabilities/built-in/apply-audit-changes';

// ─── Helpers ───────────────────────────────────────────────────────────────

// Cast away the `readonly` on `as const` tuples so Zod's `z.enum`
// accepts them. The tuple type carries the literal union, which is
// what `z.enum` infers — no type erosion.
const asEnum = <T extends readonly [string, ...string[]]>(arr: T): [...T] => [...arr];

const SOURCE_KIND = [
  'web_search',
  'training_knowledge',
  'knowledge_base',
  'prior_step',
  'external_call',
  'user_input',
] as const;

const KINDS_REQUIRING_REFERENCE = new Set([
  'web_search',
  'knowledge_base',
  'external_call',
  'prior_step',
]);

// ─── Sub-schemas ───────────────────────────────────────────────────────────

const sourceAttributionSchema = z
  .object({
    source: z.enum(asEnum(SOURCE_KIND)),
    confidence: z.enum(asEnum(CONFIDENCE)),
    reference: z.string().optional(),
    snippet: z.string().optional(),
    note: z.string().optional(),
    stepId: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    // Rule 9c: `web_search` / `knowledge_base` / `external_call` /
    // `prior_step` sources need a non-empty reference (URL, chunk
    // id, or step path). The LLM mode validator used to enforce
    // this in prose; here it's a one-line refine.
    if (KINDS_REQUIRING_REFERENCE.has(s.source)) {
      if (typeof s.reference !== 'string' || s.reference.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${s.source} source requires a non-empty \`reference\``,
          path: ['reference'],
        });
      }
    }
    // Rule 9d: training_knowledge sources cap confidence at medium.
    // High confidence on a training-only source is the audit's #1
    // confabulation signal — the model claims certainty about
    // something it pulled out of its weights.
    if (s.source === 'training_knowledge' && s.confidence === 'high') {
      ctx.addIssue({
        code: 'custom',
        message: '`training_knowledge` sources must be confidence `medium` or `low` — never `high`',
        path: ['confidence'],
      });
    }
  });

// Per-field enum lookup so the change's `proposedValue` can be
// validated against the right closed set. Mirrors `ENUM_BY_AUDIT_FIELD`
// in `lib/orchestration/model-audit/enums.ts` — the same constant the
// admin UI's per-field Select widget uses.
const PER_FIELD_ENUMS: Record<string, readonly string[]> = {
  tierRole: TIER_ROLES,
  reasoningDepth: REASONING_DEPTH,
  latency: LATENCY,
  costEfficiency: COST_EFFICIENCY,
  contextLength: CONTEXT_LENGTH,
  toolUse: TOOL_USE,
  quality: QUALITY,
  confidence: CONFIDENCE,
};

const ARRAY_FIELD_ENUMS: Record<string, readonly string[]> = {
  capabilities: CAPABILITIES,
  deploymentProfiles: DEPLOYMENT_PROFILES,
};

const changeSchema = z
  .object({
    field: z.enum(asEnum(AUDITABLE_FIELDS)),
    currentValue: z.unknown(),
    proposedValue: z.unknown(),
    reason: z.string().min(1),
    confidence: z.enum(asEnum(CONFIDENCE)),
    sources: z.array(sourceAttributionSchema).min(1, 'sources must be non-empty'),
  })
  .superRefine((change, ctx) => {
    // Per-field enum check: the proposedValue must be in the
    // corresponding enum when the field is one of the enum-typed
    // fields. Hits Rule 2 of the old LLM validator.
    const allowed = PER_FIELD_ENUMS[change.field];
    if (allowed) {
      if (typeof change.proposedValue !== 'string') {
        ctx.addIssue({
          code: 'custom',
          message: `field "${change.field}": proposedValue must be a string`,
          path: ['proposedValue'],
        });
      } else if (!allowed.includes(change.proposedValue)) {
        ctx.addIssue({
          code: 'custom',
          message: `field "${change.field}": proposedValue "${change.proposedValue}" is not in [${allowed.join(', ')}]`,
          path: ['proposedValue'],
        });
      }
    }
    // Per-element membership for array fields. Hits Rule 3 (the
    // `capabilities` array — the specific failure that motivated
    // this rewrite) and Rule 4 (deploymentProfiles).
    const arrayAllowed = ARRAY_FIELD_ENUMS[change.field];
    if (arrayAllowed) {
      if (!Array.isArray(change.proposedValue)) {
        ctx.addIssue({
          code: 'custom',
          message: `field "${change.field}": proposedValue must be an array`,
          path: ['proposedValue'],
        });
      } else {
        // `proposedValue` is `unknown` at the schema level; narrow
        // to `unknown[]` after the Array.isArray() guard above.
        const proposed = change.proposedValue as unknown[];
        for (let i = 0; i < proposed.length; i++) {
          const el = proposed[i];
          if (typeof el !== 'string' || !arrayAllowed.includes(el)) {
            ctx.addIssue({
              code: 'custom',
              message: `field "${change.field}": element "${String(el)}" is not in [${arrayAllowed.join(', ')}]`,
              path: ['proposedValue', i],
            });
          }
        }
        if (change.field === 'deploymentProfiles' && proposed.length === 0) {
          // Rule 4 also forbids empty deploymentProfiles arrays —
          // every model has at least one deployment locus.
          ctx.addIssue({
            code: 'custom',
            message: 'deploymentProfiles cannot be an empty array',
            path: ['proposedValue'],
          });
        }
      }
    }
  });

const modelProposalSchema = z.object({
  model_id: z.string().min(1),
  modelName: z.string().min(1),
  providerSlug: z.string().min(1),
  changes: z.array(changeSchema),
  overallConfidence: z.enum(asEnum(CONFIDENCE)),
  reasoning: z.string(),
});

const deactivationSchema = z.object({
  modelId: z.string().min(1),
  reason: z.string().min(1),
  sources: z.array(sourceAttributionSchema).min(1),
});

const analysisBranchSchema = z.object({
  models: z.array(modelProposalSchema),
  deactivateModels: z.array(deactivationSchema),
});

const newModelSchema = z.object({
  name: z.string().min(1),
  // Rule 6: slug must match the slug regex (lowercase, hyphenated).
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  providerSlug: z.string().min(1),
  modelId: z.string().min(1),
  description: z.string().min(1),
  // Per-element enum check (Rule 3): each capability is in the
  // CAPABILITIES spec.
  capabilities: z.array(z.enum(asEnum(CAPABILITIES))),
  tierRole: z.enum(asEnum(TIER_ROLES)),
  // Rule 4: each profile in DEPLOYMENT_PROFILES; non-empty.
  deploymentProfiles: z.array(z.enum(asEnum(DEPLOYMENT_PROFILES))).min(1),
  reasoningDepth: z.enum(asEnum(REASONING_DEPTH)).optional(),
  latency: z.enum(asEnum(LATENCY)).optional(),
  costEfficiency: z.enum(asEnum(COST_EFFICIENCY)).optional(),
  contextLength: z.enum(asEnum(CONTEXT_LENGTH)).optional(),
  toolUse: z.enum(asEnum(TOOL_USE)).optional(),
  bestRole: z.string().min(1),
  sources: z.array(sourceAttributionSchema).min(1),
  // Embedding-only enrichment fields. Optional so the chat / agent
  // new-model proposals don't have to carry them.
  dimensions: z.number().int().positive().optional(),
  quality: z.enum(asEnum(QUALITY)).optional(),
  schemaCompatible: z.boolean().optional(),
});

const discoveryBranchSchema = z.object({
  newModels: z.array(newModelSchema),
  reasoning: z.string(),
});

// ─── Registration ──────────────────────────────────────────────────────────

// Compound schema — keys match the audit template's
// `inputStepIds: ['analyse_chat', 'analyse_embedding',
// 'discover_new_models']`. The executor builds `{ [stepId]: output }`
// and feeds it to this schema; mismatched keys produce a clear
// "stepId not found" issue path.
export const auditProposalsSchema = z.object({
  analyse_chat: analysisBranchSchema,
  analyse_embedding: analysisBranchSchema,
  discover_new_models: discoveryBranchSchema,
});

registerSchema('audit-proposals', auditProposalsSchema);
