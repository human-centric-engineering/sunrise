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

/** A unique constraint as Postgres names it, and the columns it covers. */
export interface UniqueConstraint {
  readonly index: string;
  readonly fields: readonly string[];
}

/** The unique constraints application code tells apart on a P2002. */
export const UNIQUE_CONSTRAINTS = {
  userEmail: { index: 'user_email_key', fields: ['email'] },
  agentSlug: { index: 'ai_agent_orgId_slug_key', fields: ['orgId', 'slug'] },
  knowledgeDocumentSlug: {
    index: 'ai_knowledge_document_orgId_slug_key',
    fields: ['orgId', 'slug'],
  },
  knowledgeRevisionVersion: {
    index: 'ai_knowledge_document_revision_documentId_version_key',
    fields: ['documentId', 'version'],
  },
  workflowExecutionDedupKey: { index: 'ai_workflow_execution_dedup_key', fields: ['dedupKey'] },
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
      .optional(),
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
  else if (constraint) fields = constraint.fields;
  else if (typeof meta.target === 'string') index = meta.target;
  else if (meta.target) fields = meta.target;
  return { modelName: meta.modelName ?? null, index, fields };
}

/** True when `err` is a P2002 on `constraint`, by its name or by its columns. */
export function isUniqueViolationOn(err: unknown, constraint: UniqueConstraint): boolean {
  const violation = uniqueViolation(err);
  if (!violation) return false;
  if (violation.index !== null) return violation.index === constraint.index;
  if (violation.fields !== null) {
    return (
      violation.fields.length === constraint.fields.length &&
      constraint.fields.every((field) => violation.fields?.includes(field))
    );
  }
  return false;
}
