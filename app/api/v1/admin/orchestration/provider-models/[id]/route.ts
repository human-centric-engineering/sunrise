/**
 * Admin Orchestration — Single provider model (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/provider-models/:id — single model
 * PATCH  /api/v1/admin/orchestration/provider-models/:id — update, sets isDefault=false
 * DELETE /api/v1/admin/orchestration/provider-models/:id — hard delete, refused
 *        (409 MODEL_IN_USE) when any active agent or active workflow still
 *        references the row's (providerSlug, modelId) pair.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import { updateProviderModelSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

function parseModelId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid provider model id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseModelId(rawId);

  const model = await prisma.aiProviderModel.findUnique({ where: { id } });
  if (!model) throw new NotFoundError(`Provider model ${id} not found`);

  // Enrich with configured provider info
  const config = await prisma.aiProviderConfig.findFirst({
    where: { slug: model.providerSlug },
    select: { slug: true, isActive: true },
  });

  log.info('Provider model fetched', { modelId: id });
  return successResponse({
    ...model,
    configured: !!config,
    configuredActive: config?.isActive ?? false,
  });
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseModelId(rawId);

  const current = await prisma.aiProviderModel.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Provider model ${id} not found`);

  const body = await validateRequestBody(request, updateProviderModelSchema);

  const data: Prisma.AiProviderModelUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.providerSlug !== undefined) data.providerSlug = body.providerSlug;
  if (body.modelId !== undefined) data.modelId = body.modelId;
  if (body.description !== undefined) data.description = body.description;
  if (body.capabilities !== undefined) data.capabilities = body.capabilities;
  if (body.tierRole !== undefined) data.tierRole = body.tierRole;
  if (body.reasoningDepth !== undefined) data.reasoningDepth = body.reasoningDepth;
  if (body.latency !== undefined) data.latency = body.latency;
  if (body.costEfficiency !== undefined) data.costEfficiency = body.costEfficiency;
  if (body.contextLength !== undefined) data.contextLength = body.contextLength;
  if (body.toolUse !== undefined) data.toolUse = body.toolUse;
  if (body.bestRole !== undefined) data.bestRole = body.bestRole;
  if (body.dimensions !== undefined) data.dimensions = body.dimensions;
  if (body.schemaCompatible !== undefined) data.schemaCompatible = body.schemaCompatible;
  if (body.costPerMillionTokens !== undefined)
    data.costPerMillionTokens = body.costPerMillionTokens;
  if (body.hasFreeTier !== undefined) data.hasFreeTier = body.hasFreeTier;
  if (body.local !== undefined) data.local = body.local;
  if (body.quality !== undefined) data.quality = body.quality;
  if (body.strengths !== undefined) data.strengths = body.strengths;
  if (body.setup !== undefined) data.setup = body.setup;
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.metadata !== undefined) data.metadata = body.metadata as Prisma.InputJsonValue;

  // Admin editing a seed-managed row opts it out of future seed updates
  if (current.isDefault) {
    data.isDefault = false;
  }

  // Skip no-op update when only isDefault flip and no user-supplied fields
  const userFields = Object.keys(data).filter((k) => k !== 'isDefault');
  if (userFields.length === 0 && !current.isDefault) {
    log.info('Provider model PATCH skipped (no fields changed)', { modelId: id });
    return successResponse(current);
  }

  try {
    const updated = await prisma.aiProviderModel.update({ where: { id }, data });

    invalidateModelCache();

    log.info('Provider model updated', {
      modelId: id,
      adminId: session.user.id,
      fieldsChanged: Object.keys(data),
    });

    return successResponse(updated);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ValidationError(`Provider model with slug '${body.slug}' already exists`, {
        slug: ['Slug is already in use'],
      });
    }
    throw err;
  }
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseModelId(rawId);

  const current = await prisma.aiProviderModel.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Provider model ${id} not found`);

  // In-use guard: refuse to delete when any active agent or active
  // workflow (published version or in-progress draft) still references
  // the (providerSlug, modelId) pair. AiAgent stores both as plain
  // strings; workflows pin via `step.config.modelOverride` (just the
  // bare modelId — provider context is resolved from the model registry
  // at runtime).
  const [boundAgents, boundWorkflows] = await Promise.all([
    prisma.aiAgent.findMany({
      where: {
        isActive: true,
        provider: current.providerSlug,
        model: current.modelId,
      },
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    }),
    findWorkflowsPinningModel(current.modelId),
  ]);

  if (boundAgents.length > 0 || boundWorkflows.length > 0) {
    log.info('Provider model delete refused — model in use', {
      modelId: id,
      slug: current.slug,
      agentCount: boundAgents.length,
      workflowCount: boundWorkflows.length,
    });
    return errorResponse(buildInUseMessage(current.name, boundAgents, boundWorkflows), {
      code: 'MODEL_IN_USE',
      status: 409,
      details: { agents: boundAgents, workflows: boundWorkflows },
    });
  }

  await prisma.aiProviderModel.delete({ where: { id } });

  invalidateModelCache();

  log.info('Provider model deleted', {
    modelId: id,
    slug: current.slug,
    adminId: session.user.id,
  });

  return successResponse({ id, deleted: true });
});

interface BoundRef {
  id: string;
  name: string;
  slug: string;
}

// Step types whose `config.modelOverride` pins a specific model. Mirrors
// the LLM_STEP_TYPES set in lib/orchestration/workflows/semantic-validator.ts;
// kept in sync by hand because exporting from the validator would pull its
// runtime deps (model registry) into this admin route for no benefit.
const LLM_STEP_TYPES = new Set([
  'llm_call',
  'route',
  'reflect',
  'guard',
  'evaluate',
  'plan',
  'orchestrator',
]);

function definitionPinsModel(definition: unknown, modelId: string): boolean {
  if (!definition || typeof definition !== 'object') return false;
  const steps = (definition as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return false;
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const type = (step as { type?: unknown }).type;
    if (typeof type !== 'string' || !LLM_STEP_TYPES.has(type)) continue;
    const config = (step as { config?: unknown }).config;
    if (!config || typeof config !== 'object') continue;
    const override = (config as { modelOverride?: unknown }).modelOverride;
    if (typeof override === 'string' && override === modelId) return true;
  }
  return false;
}

async function findWorkflowsPinningModel(modelId: string): Promise<BoundRef[]> {
  const workflows = await prisma.aiWorkflow.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      slug: true,
      draftDefinition: true,
      publishedVersion: { select: { snapshot: true } },
    },
    orderBy: { name: 'asc' },
  });

  const matches: BoundRef[] = [];
  for (const w of workflows) {
    const draftPins = definitionPinsModel(w.draftDefinition, modelId);
    const publishedPins = definitionPinsModel(w.publishedVersion?.snapshot, modelId);
    if (draftPins || publishedPins) {
      matches.push({ id: w.id, name: w.name, slug: w.slug });
    }
  }
  return matches;
}

function buildInUseMessage(modelName: string, agents: BoundRef[], workflows: BoundRef[]): string {
  const parts: string[] = [];
  if (agents.length > 0) {
    parts.push(`${agents.length} active agent${agents.length === 1 ? '' : 's'}`);
  }
  if (workflows.length > 0) {
    parts.push(`${workflows.length} active workflow${workflows.length === 1 ? '' : 's'}`);
  }
  return `Cannot delete model "${modelName}" — ${parts.join(' and ')} still reference${
    agents.length + workflows.length === 1 ? 's' : ''
  } it. Re-point them to a different model first.`;
}
