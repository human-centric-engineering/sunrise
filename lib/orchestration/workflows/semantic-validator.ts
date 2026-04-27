/**
 * Semantic Workflow Validator
 *
 * DB-backed validation that checks whether a workflow's steps reference
 * real, active resources:
 *
 *   - LLM steps with `modelOverride` → model exists in the registry and
 *     its provider is active in the database
 *   - `tool_call` steps with `capabilitySlug` → capability exists and is active
 *   - `agent_call` steps with `agentSlug` → agent exists and is active
 *
 * Separated from the pure structural `validateWorkflow()` so that
 * callers who don't need (or can't afford) DB access can still run
 * structural checks independently.
 *
 * Platform-agnostic w.r.t. Next.js, but requires Prisma + model registry.
 */

import { prisma } from '@/lib/db/client';
import { modelRegistry } from '@/lib/orchestration/llm';
import type { WorkflowDefinition } from '@/types/orchestration';

// ── Types ──────────────────────────────────────────────────────────────────

export type SemanticErrorCode =
  | 'UNKNOWN_MODEL_OVERRIDE'
  | 'INACTIVE_PROVIDER'
  | 'INACTIVE_CAPABILITY'
  | 'INACTIVE_AGENT';

export interface SemanticValidationError {
  code: SemanticErrorCode;
  message: string;
  stepId: string;
}

export interface SemanticValidationResult {
  ok: boolean;
  errors: SemanticValidationError[];
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Step types that accept an optional `modelOverride` in their config. */
const LLM_STEP_TYPES = new Set([
  'llm_call',
  'route',
  'reflect',
  'guard',
  'evaluate',
  'plan',
  'orchestrator',
]);

// ── Validator ──────────────────────────────────────────────────────────────

/**
 * Run semantic (DB-backed) validation on a workflow definition.
 *
 * Single-pass collection of unique model overrides and capability slugs,
 * then two batch DB queries to check existence and activity.
 */
export async function semanticValidateWorkflow(
  def: WorkflowDefinition
): Promise<SemanticValidationResult> {
  const errors: SemanticValidationError[] = [];

  // ── Collect unique references ──────────────────────────────────────────

  /** Map model id → step ids that reference it */
  const modelSteps = new Map<string, string[]>();
  /** Map capability slug → step ids that reference it */
  const capabilitySteps = new Map<string, string[]>();
  /** Map agent slug → step ids that reference it */
  const agentSteps = new Map<string, string[]>();

  for (const step of def.steps) {
    if (LLM_STEP_TYPES.has(step.type)) {
      const override = step.config?.modelOverride;
      if (typeof override === 'string' && override.length > 0) {
        const existing = modelSteps.get(override) ?? [];
        existing.push(step.id);
        modelSteps.set(override, existing);
      }
    }

    if (step.type === 'tool_call') {
      const slug = step.config?.capabilitySlug;
      if (typeof slug === 'string' && slug.length > 0) {
        const existing = capabilitySteps.get(slug) ?? [];
        existing.push(step.id);
        capabilitySteps.set(slug, existing);
      }
    }

    if (step.type === 'agent_call') {
      const slug = step.config?.agentSlug;
      if (typeof slug === 'string' && slug.length > 0) {
        const existing = agentSteps.get(slug) ?? [];
        existing.push(step.id);
        agentSteps.set(slug, existing);
      }
    }
  }

  // Nothing to check — fast path
  if (modelSteps.size === 0 && capabilitySteps.size === 0 && agentSteps.size === 0) {
    return { ok: true, errors: [] };
  }

  // ── Batch DB queries ───────────────────────────────────────────────────

  const [activeProviders, activeCapabilities, activeAgents] = await Promise.all([
    modelSteps.size > 0
      ? prisma.aiProviderConfig.findMany({
          where: { isActive: true },
          select: { slug: true },
        })
      : Promise.resolve([]),
    capabilitySteps.size > 0
      ? prisma.aiCapability.findMany({
          where: {
            slug: { in: [...capabilitySteps.keys()] },
            isActive: true,
          },
          select: { slug: true },
        })
      : Promise.resolve([]),
    agentSteps.size > 0
      ? prisma.aiAgent.findMany({
          where: {
            slug: { in: [...agentSteps.keys()] },
            isActive: true,
          },
          select: { slug: true },
        })
      : Promise.resolve([]),
  ]);

  // ── Check model overrides ──────────────────────────────────────────────

  const activeProviderSlugs = new Set(activeProviders.map((p) => p.slug));

  for (const [modelId, stepIds] of modelSteps) {
    const model = modelRegistry.getModel(modelId);
    if (!model) {
      for (const stepId of stepIds) {
        errors.push({
          code: 'UNKNOWN_MODEL_OVERRIDE',
          message: `Step "${stepId}" references unknown model "${modelId}"`,
          stepId,
        });
      }
      continue;
    }

    if (!activeProviderSlugs.has(model.provider)) {
      for (const stepId of stepIds) {
        errors.push({
          code: 'INACTIVE_PROVIDER',
          message: `Step "${stepId}" references model "${modelId}" whose provider "${model.provider}" is inactive`,
          stepId,
        });
      }
    }
  }

  // ── Check capability slugs ─────────────────────────────────────────────

  const activeCapSlugs = new Set(activeCapabilities.map((c) => c.slug));

  for (const [slug, stepIds] of capabilitySteps) {
    if (!activeCapSlugs.has(slug)) {
      for (const stepId of stepIds) {
        errors.push({
          code: 'INACTIVE_CAPABILITY',
          message: `Step "${stepId}" references inactive or unknown capability "${slug}"`,
          stepId,
        });
      }
    }
  }

  // ── Check agent slugs ──────────────────────────────────────────────────

  const activeAgentSlugs = new Set(activeAgents.map((a) => a.slug));

  for (const [slug, stepIds] of agentSteps) {
    if (!activeAgentSlugs.has(slug)) {
      for (const stepId of stepIds) {
        errors.push({
          code: 'INACTIVE_AGENT',
          message: `Step "${stepId}" references inactive or unknown agent "${slug}"`,
          stepId,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
