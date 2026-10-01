/**
 * Semantic Workflow Validator
 *
 * DB-backed validation that checks whether a workflow's steps reference
 * real, active resources:
 *
 *   - LLM steps with `modelOverride` → model exists in the registry, its
 *     provider is active in the database, and — at `TENANCY_MODE=multi` — the
 *     org in context is approved for that provider (§120 t-743)
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
import { logger } from '@/lib/logging';
import type { WorkflowDefinition } from '@/types/orchestration';
import { platformSlugsWhere } from '@/lib/orchestration/agents/platform-agent-guard';
import { unapprovedProviders } from '@/lib/orchestration/llm/org-provider-policy';

// ── Types ──────────────────────────────────────────────────────────────────

export type SemanticErrorCode =
  | 'UNKNOWN_MODEL_OVERRIDE'
  | 'INACTIVE_PROVIDER'
  | 'PROVIDER_NOT_APPROVED'
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

// ── Org approval ───────────────────────────────────────────────────────────

/** Model id → the LLM steps that override to it. */
function collectModelOverrides(def: WorkflowDefinition): Map<string, string[]> {
  const modelSteps = new Map<string, string[]>();
  for (const step of def.steps) {
    if (!LLM_STEP_TYPES.has(step.type)) continue;
    const override = step.config?.modelOverride;
    if (typeof override === 'string' && override.length > 0) {
      modelSteps.set(override, [...(modelSteps.get(override) ?? []), step.id]);
    }
  }
  return modelSteps;
}

/**
 * Steps whose `modelOverride` names a model whose provider the org in context
 * is not approved for (§120 t-743). Empty at `single` and for the install org.
 *
 * A step override is an operator's explicit choice, which the call-time gate
 * refuses rather than reroutes, so a step saved naming such a provider fails
 * on every run. This says so at save instead. An unknown model is left to the
 * semantic validator's own `UNKNOWN_MODEL_OVERRIDE`.
 *
 * Exported for workflow CREATE, which publishes v1 without the rest of the
 * semantic validation; publish, rollback, validate and dry-run reach it
 * through {@link semanticValidateWorkflow}.
 *
 * @throws when the org's policy cannot be read.
 */
export async function findUnapprovedModelOverrides(
  def: WorkflowDefinition
): Promise<SemanticValidationError[]> {
  const modelSteps = collectModelOverrides(def);
  const providerByModel = new Map<string, string>();
  for (const modelId of modelSteps.keys()) {
    const model = modelRegistry.getModel(modelId);
    if (model) providerByModel.set(modelId, model.provider);
  }
  return approvalErrors(modelSteps, providerByModel);
}

/** The approval check, given each override's provider already looked up. */
async function approvalErrors(
  modelSteps: Map<string, string[]>,
  providerByModel: Map<string, string>
): Promise<SemanticValidationError[]> {
  const refused = new Set(await unapprovedProviders([...providerByModel.values()]));
  const errors: SemanticValidationError[] = [];
  for (const [modelId, stepIds] of modelSteps) {
    const provider = providerByModel.get(modelId);
    if (provider === undefined || !refused.has(provider)) continue;
    for (const stepId of stepIds) {
      errors.push({
        code: 'PROVIDER_NOT_APPROVED',
        message: `Step "${stepId}" references model "${modelId}", whose provider "${provider}" this organisation is not approved to use`,
        stepId,
      });
    }
  }
  return errors;
}

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
  const modelSteps = collectModelOverrides(def);
  /** Map capability slug → step ids that reference it */
  const capabilitySteps = new Map<string, string[]>();
  /** Map agent slug → step ids that reference it */
  const agentSteps = new Map<string, string[]>();

  for (const step of def.steps) {
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
  // Wrapped in try-catch so a temporary DB outage degrades gracefully
  // (skips semantic checks) instead of crashing the entire validation.

  let activeProviders: Array<{ slug: string }> = [];
  let activeCapabilities: Array<{ slug: string }> = [];
  let activeAgents: Array<{ slug: string }> = [];

  try {
    [activeProviders, activeCapabilities, activeAgents] = await Promise.all([
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
              // As agent_call resolves them: a platform slug is its system row.
              ...platformSlugsWhere([...agentSteps.keys()]),
            },
            select: { slug: true },
          })
        : Promise.resolve([]),
    ]);
  } catch (err) {
    logger.error('Semantic validator: DB query failed, skipping semantic checks', { error: err });
    return { ok: true, errors: [] };
  }

  // ── Check model overrides ──────────────────────────────────────────────

  const activeProviderSlugs = new Set(activeProviders.map((p) => p.slug));

  const providerByModel = new Map<string, string>();
  for (const [modelId, stepIds] of modelSteps) {
    const model = modelRegistry.getModel(modelId);
    if (model) providerByModel.set(modelId, model.provider);
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

  // ── Check org approval of override providers (§120 t-743) ──────────────
  // Its own failure is handled as the queries above are: logged and skipped,
  // so a policy read that fails does not block a save. The call-time gate
  // still refuses every call such a step makes.
  if (modelSteps.size > 0) {
    try {
      errors.push(...(await approvalErrors(modelSteps, providerByModel)));
    } catch (err) {
      logger.error('Semantic validator: org provider policy unreadable, skipping approval check', {
        error: err,
      });
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
