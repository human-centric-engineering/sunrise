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
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import {
  providerModelUsage,
  type ProviderModelUsage,
} from '@/lib/orchestration/admin/global-config-usage';
import { updateProviderModelSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'provider model id' });

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

export const PATCH = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const id = validatePathParam(rawId, cuidSchema, { label: 'provider model id' });

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
    if (body.paramProfile !== undefined) data.paramProfile = body.paramProfile;
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
    if (body.metadata !== undefined) data.metadata = body.metadata;

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
  },
  { writesSharedSettings: true }
);

export const DELETE = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const id = validatePathParam(rawId, cuidSchema, { label: 'provider model id' });

    const current = await prisma.aiProviderModel.findUnique({ where: { id } });
    if (!current) throw new NotFoundError(`Provider model ${id} not found`);

    // In-use guard: refuse to delete when any active agent or active
    // workflow (published version or in-progress draft) still references
    // the (providerSlug, modelId) pair. AiAgent stores both as plain
    // strings; workflows pin via `step.config.modelOverride` (just the
    // bare modelId — provider context is resolved from the model registry
    // at runtime).
    //
    // In every org (t-731): the model is global config, so another org's
    // agents and workflows refuse the delete too. Only the caller's own are
    // named; another org's are a count.
    const usage = await providerModelUsage(current.providerSlug, current.modelId);
    const agentCount = usage.agents.length + usage.otherOrgAgents;
    const workflowCount = usage.workflows.length + usage.otherOrgWorkflows;

    if (agentCount > 0 || workflowCount > 0) {
      log.info('Provider model delete refused — model in use', {
        modelId: id,
        slug: current.slug,
        agentCount,
        workflowCount,
        otherOrgAgentCount: usage.otherOrgAgents,
        otherOrgWorkflowCount: usage.otherOrgWorkflows,
      });
      return errorResponse(buildInUseMessage(current.name, usage), {
        code: 'MODEL_IN_USE',
        status: 409,
        details: {
          agents: usage.agents,
          workflows: usage.workflows,
          otherOrgAgentCount: usage.otherOrgAgents,
          otherOrgWorkflowCount: usage.otherOrgWorkflows,
        },
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
  },
  { writesSharedSettings: true }
);

function buildInUseMessage(modelName: string, usage: ProviderModelUsage): string {
  const agents = usage.agents.length + usage.otherOrgAgents;
  const workflows = usage.workflows.length + usage.otherOrgWorkflows;
  const parts: string[] = [];
  if (agents > 0) {
    parts.push(`${agents} active agent${agents === 1 ? '' : 's'}`);
  }
  if (workflows > 0) {
    parts.push(`${workflows} active workflow${workflows === 1 ? '' : 's'}`);
  }
  const elsewhere = usage.otherOrgAgents + usage.otherOrgWorkflows;
  return `Cannot delete model "${modelName}" — ${parts.join(' and ')} still reference${
    agents + workflows === 1 ? 's' : ''
  } it${
    elsewhere > 0 ? ` (${elsewhere} of them in other organisations)` : ''
  }. Re-point them to a different model first.`;
}
