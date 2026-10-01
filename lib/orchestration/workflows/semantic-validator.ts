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
import { ValidationError } from '@/lib/api/errors';
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

/**
 * Step types whose `modelOverride` chooses a provider, for the org-approval
 * check (§120 t-743): the above plus `supervisor`, which passes its override
 * to `runLlmCall` too. Kept apart so adding it here does not also subject
 * supervisor steps to the existence checks above, at execution, unasked.
 * (`chat_turn` takes an override too, but only of the model on the agent's
 * own provider binding, so it names no provider.)
 */
const PROVIDER_CHOOSING_STEP_TYPES = new Set([...LLM_STEP_TYPES, 'supervisor']);

// ── Org approval ───────────────────────────────────────────────────────────

/** Model id → the steps of `types` that override to it. */
function collectModelOverrides(
  def: WorkflowDefinition,
  types: ReadonlySet<string> = LLM_STEP_TYPES
): Map<string, string[]> {
  const modelSteps = new Map<string, string[]>();
  for (const step of def.steps) {
    if (!types.has(step.type)) continue;
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

/** How the org-approval check of override providers is asked (§120 t-743). */
export interface ApprovalCheck {
  /**
   * The definition being replaced — the published version a publish or
   * rollback supersedes — loaded only if something would otherwise be
   * refused. A provider its overrides already use is excused, the rule agents
   * follow: a workflow stranded by a later policy change can still publish an
   * unrelated edit, and only a provider the write INTRODUCES is refused.
   */
  held?: () => Promise<WorkflowDefinition | null>;
  /**
   * An unreadable policy throws by default — a save fails loudly rather than
   * passing unchecked. A diagnostic that saves nothing passes `'skip'`.
   */
  onUnreadable?: 'throw' | 'skip';
}

/**
 * For each definition, the steps whose `modelOverride` names a model whose
 * provider the org in context is not approved for, excusing what `held`
 * already used. Empty at `single` and for the install org.
 *
 * A step override is an operator's explicit choice, which the call-time gate
 * refuses rather than reroutes, so a step saved naming such a provider fails
 * on every run; this says so at save instead. The registry is hydrated from
 * the operator's Model Matrix first, so a model added there resolves to its
 * provider; one that still does not is left to `UNKNOWN_MODEL_OVERRIDE`.
 *
 * Batched for the backup import: one hydrate and one policy question for
 * every definition. Execution does not ask at all — a step the gate refuses
 * there takes its own error strategy, and refusing the whole run up front
 * would stop runs that skip or fall back from it.
 *
 * @throws when the org's policy cannot be read.
 */
export async function findUnapprovedModelOverridesIn<K>(
  defs: ReadonlyMap<K, WorkflowDefinition>,
  check: Pick<ApprovalCheck, 'held'> = {}
): Promise<Map<K, SemanticValidationError[]>> {
  await hydrateModelRegistryFromDb();
  const looked = new Map(
    [...defs].map(([key, def]) => {
      const modelSteps = collectModelOverrides(def, PROVIDER_CHOOSING_STEP_TYPES);
      return [key, { modelSteps, providerByModel: providersOf(modelSteps) }] as const;
    })
  );
  const refused = new Set(
    await unapprovedProviders([...looked.values()].flatMap((l) => [...l.providerByModel.values()]))
  );
  if (refused.size > 0 && check.held) {
    const held = await check.held();
    if (held) {
      for (const provider of providersOf(
        collectModelOverrides(held, PROVIDER_CHOOSING_STEP_TYPES)
      ).values()) {
        refused.delete(provider);
      }
    }
  }

  const result = new Map<K, SemanticValidationError[]>();
  for (const [key, { modelSteps, providerByModel }] of looked) {
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
    result.set(key, errors);
  }
  return result;
}

/** {@link findUnapprovedModelOverridesIn} for one definition. */
export async function findUnapprovedModelOverrides(
  def: WorkflowDefinition,
  check: Pick<ApprovalCheck, 'held'> = {}
): Promise<SemanticValidationError[]> {
  return (await findUnapprovedModelOverridesIn(new Map([[0, def]]), check)).get(0) ?? [];
}

/**
 * Refuse a workflow definition that would be published with a step overriding
 * to a provider the org is not approved for. For the paths that publish a v1
 * without the rest of the semantic validation: workflow create and
 * save-as-template.
 *
 * @throws ValidationError naming each refused step.
 */
export async function assertWorkflowProvidersApproved(def: WorkflowDefinition): Promise<void> {
  const errors = await findUnapprovedModelOverrides(def);
  if (errors.length === 0) return;
  throw new ValidationError('Workflow steps use providers this organisation is not approved for', {
    definition: errors.map((e) => e.message),
  });
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

  // ── Org approval of override providers (§120 t-743) ────────────────────
  // Before the existence queries, so their graceful skip on a DB failure
  // cannot skip this too: a save asked for it, and an unreadable policy
  // fails the save (throws) unless the caller is a diagnostic that said skip.
  let approval: SemanticValidationError[] = [];
  if (options.approval) {
    try {
      approval = await findUnapprovedModelOverrides(def, options.approval);
    } catch (err) {
      if (options.approval.onUnreadable !== 'skip') throw err;
      logger.error('Semantic validator: org provider policy unreadable, skipping approval check', {
        error: err,
      });
    }
  }

  // Nothing to check — fast path
  if (modelSteps.size === 0 && capabilitySteps.size === 0 && agentSteps.size === 0) {
    return { ok: approval.length === 0, errors: approval };
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
