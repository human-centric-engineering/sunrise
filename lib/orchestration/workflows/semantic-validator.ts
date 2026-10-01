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
import { hydrateFromDb as hydrateModelRegistryFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';

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

/**
 * Step types whose `modelOverride` chooses the model, and so its provider.
 * (`chat_turn` also takes one, but it overrides only the model on the agent's
 * own provider binding, so it names no provider.)
 */
const LLM_STEP_TYPES = new Set([
  'llm_call',
  'route',
  'reflect',
  'guard',
  'evaluate',
  'plan',
  'orchestrator',
  'supervisor',
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

/** Each override's provider, from the registry; an unknown model has none. */
function providersOf(modelSteps: Map<string, string[]>): Map<string, string> {
  const providerByModel = new Map<string, string>();
  for (const modelId of modelSteps.keys()) {
    const model = modelRegistry.getModel(modelId);
    if (model) providerByModel.set(modelId, model.provider);
  }
  return providerByModel;
}

/**
 * Ask for an org-approval check of override providers (§120 t-743).
 *
 * `held` is the definition being replaced — the published version a publish
 * or rollback supersedes. A provider its overrides already use is not
 * re-checked, the rule agents follow: a workflow stranded by a later policy
 * change can still publish an unrelated edit, and only a provider the write
 * INTRODUCES is refused.
 */
export interface ApprovalCheck {
  held?: WorkflowDefinition | null;
}

/**
 * Steps whose `modelOverride` names a model whose provider the org in context
 * is not approved for, and which `held` did not already use. Empty at
 * `single` and for the install org.
 *
 * A step override is an operator's explicit choice, which the call-time gate
 * refuses rather than reroutes, so a step saved naming such a provider fails
 * on every run. This says so at save instead. The registry is hydrated from
 * the operator's Model Matrix first, so a model added there resolves to its
 * provider; one that still does not resolve is left to
 * `UNKNOWN_MODEL_OVERRIDE`.
 *
 * Exported for workflow CREATE, which publishes v1 without the rest of the
 * semantic validation; publish, rollback and validate reach it through
 * {@link semanticValidateWorkflow}'s `approval` option. Execution does not ask:
 * a step the gate refuses there takes its own error strategy, and refusing the
 * whole run up front would stop runs that skip or fall back from it.
 *
 * @throws when the org's policy cannot be read — a save fails loudly rather
 *   than being waved through on a check that never ran.
 */
export async function findUnapprovedModelOverrides(
  def: WorkflowDefinition,
  check: ApprovalCheck = {}
): Promise<SemanticValidationError[]> {
  await hydrateModelRegistryFromDb();
  const modelSteps = collectModelOverrides(def);
  return approvalErrors(modelSteps, providersOf(modelSteps), check);
}

/** The approval check, given each override's provider already looked up. */
async function approvalErrors(
  modelSteps: Map<string, string[]>,
  providerByModel: Map<string, string>,
  check: ApprovalCheck
): Promise<SemanticValidationError[]> {
  const held = new Set(check.held ? providersOf(collectModelOverrides(check.held)).values() : []);
  const introduced = [...new Set(providerByModel.values())].filter((slug) => !held.has(slug));
  const refused = new Set(await unapprovedProviders(introduced));
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
 *
 * Pass `approval` to also check, at `multi`, that each override's provider is
 * one the org is approved for (§120 t-743) — the save paths do; execution does
 * not (see {@link findUnapprovedModelOverrides}). Unlike the existence checks,
 * that one is not skipped when its read fails: it throws.
 */
export async function semanticValidateWorkflow(
  def: WorkflowDefinition,
  options: { approval?: ApprovalCheck } = {}
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

  // ── Org approval of override providers (§120 t-743) ────────────────────
  // Before the existence queries, so their graceful skip on a DB failure
  // cannot skip this too: a save asked for it, and an unreadable policy
  // fails the save (throws) rather than passing it unchecked.
  let approval: SemanticValidationError[] = [];
  if (options.approval && modelSteps.size > 0) {
    await hydrateModelRegistryFromDb();
    approval = await approvalErrors(modelSteps, providersOf(modelSteps), options.approval);
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
    // The approval check already ran; its findings stand.
    return { ok: approval.length === 0, errors: approval };
  }

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

  errors.push(...approval);

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
