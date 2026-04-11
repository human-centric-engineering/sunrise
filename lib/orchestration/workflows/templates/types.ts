/**
 * Workflow template types.
 *
 * Built-in `WorkflowTemplate`s are pure-TS data shared by two consumers:
 *
 * 1. `prisma/seed.ts` — upserts one `AiWorkflow` row per template with
 *    `isTemplate: true` so admins see the recipes in the workflows list.
 * 2. `components/admin/orchestration/workflow-builder/builder-toolbar.tsx` —
 *    imports the module directly to populate the "Use template" dropdown
 *    with zero latency (no network round-trip for the dropdown itself).
 *
 * Recipes match the five composition recipes documented in
 * `.claude/skills/agent-architect/SKILL.md` — the template library and
 * the skill stay aligned so a developer who reads the skill can pick
 * the same-named template from the builder toolbar.
 */

import type { WorkflowDefinition } from '@/types/orchestration';

/** A single agentic pattern referenced by a template (for display). */
export interface WorkflowTemplatePattern {
  /** Pattern number from the agent-architect skill (1–21). */
  number: number;
  /** Human-readable name, e.g. "Routing", "Human-in-the-Loop". */
  name: string;
}

/**
 * Static description + DAG for a built-in workflow template.
 *
 * The `slug` doubles as the `AiWorkflow.slug` when the seeder upserts
 * this template into the database — keeping it URL-safe and unique is
 * the caller's responsibility.
 */
export interface WorkflowTemplate {
  /** URL-safe unique identifier. Used as `AiWorkflow.slug` by the seeder. */
  slug: string;
  /** Friendly title shown in the dropdown + description dialog. */
  name: string;
  /** One-sentence summary used as `AiWorkflow.description` on seed. */
  shortDescription: string;
  /** Patterns referenced by this recipe — rendered as badges. */
  patterns: readonly WorkflowTemplatePattern[];
  /**
   * Short prose describing the flow, shown in the description dialog.
   * Kept intentionally short (one paragraph) so the dialog is scannable.
   */
  flowSummary: string;
  /** The full DAG loaded onto the canvas when the user picks this template. */
  workflowDefinition: WorkflowDefinition;
}
