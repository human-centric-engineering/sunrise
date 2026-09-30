/**
 * The workflow template catalogue: the built-in templates, served from code,
 * plus the calling org's own template rows.
 *
 * The built-ins are `BUILTIN_WORKFLOW_TEMPLATES`, not rows. They used to be
 * mirrored into install-org rows by a seed, which no other org could read,
 * and `AiWorkflow.slug` is unique across the install, so they could not be
 * copied per org either (§116 t-727). Serving them from code gives every org
 * the same twelve.
 *
 * An org's own templates are `AiWorkflow` rows with `isTemplate: true`,
 * scoped to the caller's org by the tenancy chokepoint like any other query.
 * Rows holding a built-in slug are left out: those are the retired seed rows,
 * which an admin may have switched back on, and the code version is the one
 * that is current.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@/prisma/seeds/data/templates';
import { PROVIDER_MODEL_AUDIT_TEMPLATE } from '@/prisma/seeds/data/templates/provider-model-audit';
import type { WorkflowDefinition, WorkflowTemplateMetadata } from '@/types/orchestration';

/** Where a catalogue entry comes from. */
export type WorkflowTemplateSource = 'builtin' | 'custom';

/** Upper bound on an org's own templates returned in one read. */
export const MAX_CUSTOM_TEMPLATES = 100;

interface TemplateEntryBase {
  slug: string;
  name: string;
  description: string;
  patternsUsed: number[];
}

/** A built-in template, from code: its definition and metadata are typed. */
export interface BuiltinTemplateEntry extends TemplateEntryBase {
  source: 'builtin';
  workflowDefinition: WorkflowDefinition;
  metadata: WorkflowTemplateMetadata;
}

/**
 * One of the org's own templates. Its definition is the published snapshot
 * as stored (`null` when it has none) and its metadata whatever the row
 * holds; the builder validates both before use.
 */
export interface CustomTemplateEntry extends TemplateEntryBase {
  source: 'custom';
  workflowDefinition: unknown;
  metadata: unknown;
}

/** One template the builder can load onto its canvas. */
export type WorkflowTemplateEntry = BuiltinTemplateEntry | CustomTemplateEntry;

/** The slugs of the built-in templates. */
export const BUILTIN_TEMPLATE_SLUGS: ReadonlySet<string> = new Set(
  BUILTIN_WORKFLOW_TEMPLATES.map((t) => t.slug)
);

/** True when `slug` belongs to a built-in template. */
export function isBuiltinTemplateSlug(slug: string): boolean {
  return BUILTIN_TEMPLATE_SLUGS.has(slug);
}

/**
 * The slugs of Sunrise's system workflows: rows a seed owns (`isSystem: true`)
 * and republishes on every re-seed. Today that is the provider-model audit,
 * seeded by `prisma/seeds/010-model-auditor.ts`.
 *
 * Known by slug in code for the same reason platform agents are
 * (`isReservedAgentSlug`): a consumer that only reads the row's `isSystem`
 * flag is blind whenever the row is absent or, at `multi`, belongs to
 * another org. The backup importer is one. A seed that adds a system
 * workflow adds its slug here; the `isSystem` flag still covers any this
 * list misses wherever the row is visible.
 */
export const SYSTEM_WORKFLOW_SLUGS: ReadonlySet<string> = new Set([
  PROVIDER_MODEL_AUDIT_TEMPLATE.slug,
]);

/** True when `slug` belongs to a Sunrise system workflow. */
export function isSystemWorkflowSlug(slug: string): boolean {
  return SYSTEM_WORKFLOW_SLUGS.has(slug);
}

/** The built-in templates, in their code order. */
export function listBuiltinTemplates(): BuiltinTemplateEntry[] {
  return BUILTIN_WORKFLOW_TEMPLATES.map((t) => ({
    source: 'builtin',
    slug: t.slug,
    name: t.name,
    description: t.shortDescription,
    workflowDefinition: t.workflowDefinition,
    patternsUsed: t.patterns.map((p) => p.number),
    metadata: {
      flowSummary: t.flowSummary,
      useCases: t.useCases,
      patterns: t.patterns,
    },
  }));
}

/** The org's own templates, and whether the cap cut the list short. */
export interface CustomTemplateList {
  entries: CustomTemplateEntry[];
  truncated: boolean;
}

/**
 * The calling org's own templates, by name, capped at
 * `MAX_CUSTOM_TEMPLATES`. Reads one row past the cap, so a list the cap cut
 * short says so rather than passing for the whole. Must run inside the
 * caller's tenant context.
 */
export async function listCustomTemplates(): Promise<CustomTemplateList> {
  const rows = await prisma.aiWorkflow.findMany({
    where: { isTemplate: true, slug: { notIn: [...BUILTIN_TEMPLATE_SLUGS] } },
    orderBy: { name: 'asc' },
    take: MAX_CUSTOM_TEMPLATES + 1,
    select: {
      slug: true,
      name: true,
      description: true,
      patternsUsed: true,
      metadata: true,
      publishedVersion: { select: { snapshot: true } },
    },
  });
  const entries = rows.slice(0, MAX_CUSTOM_TEMPLATES).map((row) => ({
    source: 'custom' as const,
    slug: row.slug,
    name: row.name,
    description: row.description,
    workflowDefinition: row.publishedVersion?.snapshot ?? null,
    patternsUsed: row.patternsUsed,
    metadata: row.metadata,
  }));
  return { entries, truncated: rows.length > MAX_CUSTOM_TEMPLATES };
}

/** The catalogue, and whether the org's own templates were cut short. */
export interface WorkflowTemplateCatalogue {
  templates: WorkflowTemplateEntry[];
  customTruncated: boolean;
}

/**
 * The whole catalogue: built-ins first, then the org's own. `source`
 * narrows it to one kind.
 */
export async function listWorkflowTemplates(
  source?: WorkflowTemplateSource
): Promise<WorkflowTemplateCatalogue> {
  const builtin = source === 'custom' ? [] : listBuiltinTemplates();
  const custom =
    source === 'builtin' ? { entries: [], truncated: false } : await listCustomTemplates();
  return { templates: [...builtin, ...custom.entries], customTruncated: custom.truncated };
}
