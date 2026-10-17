/**
 * Which unique constraint a Prisma P2002 collided on.
 *
 * Under Prisma 7's driver adapter a P2002 carries no `meta.target`. Its
 * `meta` is `{ modelName, driverAdapterError: { cause: { constraint } } }`,
 * where `constraint` is `{ index: "<name>" }` — or `{ fields: [...] }` when
 * Postgres reported no constraint name (measured against the dev DB in t-779
 * and t-796). Code that read `meta.target` never matched, so every caller
 * that chose a response by the collided field chose wrong (t-796).
 *
 * Callers name the constraint they handle in {@link UNIQUE_CONSTRAINTS}, and
 * a test checks each one against the migrations, so a renamed index fails a
 * test rather than silently turning a handled collision into a 500.
 */

import { Prisma } from '@prisma/client';
import { z } from 'zod';

/**
 * A unique constraint: its Postgres name, the Prisma model it is on, and the
 * columns it covers. The model disambiguates a match by columns, since two
 * tables can each have a unique key on `(orgId, slug)`.
 */
export interface UniqueConstraint {
  readonly index: string;
  readonly model: string;
  readonly fields: readonly string[];
}

/** The unique constraints application code tells apart on a P2002. */
export const UNIQUE_CONSTRAINTS = {
  userEmail: { index: 'user_email_key', model: 'User', fields: ['email'] },
  agentSlug: { index: 'ai_agent_orgId_slug_key', model: 'AiAgent', fields: ['orgId', 'slug'] },
  agentVersion: {
    index: 'ai_agent_version_agentId_version_key',
    model: 'AiAgentVersion',
    fields: ['agentId', 'version'],
  },
  workflowSlug: { index: 'ai_workflow_slug_key', model: 'AiWorkflow', fields: ['slug'] },
  knowledgeDocumentSlug: {
    index: 'ai_knowledge_document_orgId_slug_key',
    model: 'AiKnowledgeDocument',
    fields: ['orgId', 'slug'],
  },
  knowledgeRevisionVersion: {
    index: 'ai_knowledge_document_revision_documentId_version_key',
    model: 'AiKnowledgeDocumentRevision',
    fields: ['documentId', 'version'],
  },
  workflowExecutionDedupKey: {
    index: 'ai_workflow_execution_dedup_key',
    model: 'AiWorkflowExecution',
    fields: ['dedupKey'],
  },
  agentCapability: {
    index: 'ai_agent_capability_agentId_capabilityId_key',
    model: 'AiAgentCapability',
    fields: ['agentId', 'capabilityId'],
  },
  agentProfileSlug: {
    index: 'ai_agent_profile_slug_key',
    model: 'AiAgentProfile',
    fields: ['slug'],
  },
  capabilitySlug: { index: 'ai_capability_slug_key', model: 'AiCapability', fields: ['slug'] },
  providerSlug: {
    index: 'ai_provider_config_slug_key',
    model: 'AiProviderConfig',
    fields: ['slug'],
  },
  providerName: {
    index: 'ai_provider_config_name_key',
    model: 'AiProviderConfig',
    fields: ['name'],
  },
  providerModelSlug: {
    index: 'ai_provider_model_slug_key',
    model: 'AiProviderModel',
    fields: ['slug'],
  },
  providerModelPair: {
    index: 'ai_provider_model_providerSlug_modelId_key',
    model: 'AiProviderModel',
    fields: ['providerSlug', 'modelId'],
  },
  knowledgeTagSlug: { index: 'knowledge_tag_slug_key', model: 'KnowledgeTag', fields: ['slug'] },
  orgSlug: { index: 'org_slug_key', model: 'Org', fields: ['slug'] },
} as const satisfies Record<string, UniqueConstraint>;

/** What a P2002 says about the constraint it collided on. */
export interface UniqueViolation {
  modelName: string | null;
  /** The constraint's name, when the error carries one. */
  index: string | null;
  /** The constrained columns, when the error lists them instead of a name. */
  fields: string[] | null;
}

const metaSchema = z
  .object({
    modelName: z.string().optional(),
    // Pre-adapter engines: the field list, or the constraint name. A malformed
    // one is dropped rather than failing the parse and hiding the adapter's.
    target: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .catch(undefined),
    driverAdapterError: z
      .object({
        cause: z
          .object({
            constraint: z
              .union([z.object({ index: z.string() }), z.object({ fields: z.array(z.string()) })])
              .optional(),
          })
          .optional(),
      })
      .optional()
      // An adapter shape this does not know is dropped, like `target`, rather
      // than failing the parse and losing `modelName` with it.
      .catch(undefined),
  })
  .passthrough();

/** The collided constraint of a P2002, or null when `err` is not one. */
export function uniqueViolation(err: unknown): UniqueViolation | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return null;
  }
  const parsed = metaSchema.safeParse(err.meta ?? {});
  const meta = parsed.success ? parsed.data : {};
  const constraint = meta.driverAdapterError?.cause?.constraint;
  let index: string | null = null;
  let fields: string[] | null = null;
  if (constraint && 'index' in constraint) index = constraint.index;
  // adapter-pg parses these from Postgres's `Key ("orgId", slug)=...` detail,
  // which double-quotes a mixed-case column.
  else if (constraint) fields = constraint.fields.map((f) => f.replace(/^"(.*)"$/, '$1'));
  else if (typeof meta.target === 'string') index = meta.target;
  else if (meta.target) fields = meta.target;
  return { modelName: meta.modelName ?? null, index, fields };
}

/**
 * True when `err` is a P2002 on `constraint`: by its name, or else by its
 * columns on the same model (a columns-only error that names no model is not
 * matched, since the columns alone do not say which table).
 */
export function isUniqueViolationOn(err: unknown, constraint: UniqueConstraint): boolean {
  const violation = uniqueViolation(err);
  if (!violation) return false;
  if (violation.index !== null) return violation.index === constraint.index;
  const { fields } = violation;
  if (fields === null || violation.modelName !== constraint.model) return false;
  return (
    fields.length === constraint.fields.length &&
    constraint.fields.every((field) => fields.includes(field))
  );
}
