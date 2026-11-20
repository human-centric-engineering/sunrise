/**
 * Admin Orchestration — Single provider model (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/provider-models/:id — single model
 * PATCH  /api/v1/admin/orchestration/provider-models/:id — update, sets isDefault=false.
 *        Sets or clears the vendor retirement (`retiresAt`, `replacementId`,
 *        §136 t-1064); a replacement must pass `checkReplacement`. Every
 *        change is written to the admin audit log.
 * DELETE /api/v1/admin/orchestration/provider-models/:id — hard delete, refused
 *        (409 MODEL_IN_USE) when any active agent or active workflow still
 *        references the row's (providerSlug, modelId) pair, a saved setting
 *        names it (§136 t-1065), or the app reports a use of it; and refused
 *        (409 MODEL_USES_UNREADABLE) while the app's report of its own uses
 *        failed (§136 t-1067).
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import type { ProviderModelUsage } from '@/lib/orchestration/admin/global-config-usage';
import { updateProviderModelSchema } from '@/lib/validations/orchestration';
import {
  isHalfPrice,
  missingPriceField,
  PRICE_PAIR_MESSAGE,
} from '@/lib/validations/model-pricing';
import { cuidSchema } from '@/lib/validations/common';
import { getClientIP } from '@/lib/security/ip';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { checkReplacement, modelLifecycleState } from '@/lib/orchestration/model-lifecycle/state';
import { modelUses } from '@/lib/orchestration/model-lifecycle/uses';
import { administersPlatform } from '@/lib/auth/admin-viewer';
import { findReplacementById } from '@/lib/orchestration/model-lifecycle/replacement';

/** The database CHECK that holds the price pair (A10, t-774). */
const PRICE_PAIR_CONSTRAINT = 'ai_provider_model_price_pair';

function pricePairError(input: number | null | undefined): ValidationError {
  return new ValidationError(PRICE_PAIR_MESSAGE, {
    [missingPriceField(input)]: [PRICE_PAIR_MESSAGE],
  });
}

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'provider model id' });

  const model = await prisma.aiProviderModel.findUnique({
    where: { id },
    include: {
      replacement: {
        select: { id: true, name: true, modelId: true, isActive: true, retiresAt: true },
      },
    },
  });
  if (!model) throw new NotFoundError(`Provider model ${id} not found`);

  // Other orgs' uses are counted for a platform admin; a customer org's admin
  // would see only their own (§111 t-811), as on the models list.
  const platform = await administersPlatform(session.principal);
  const [config, uses] = await Promise.all([
    prisma.aiProviderConfig.findFirst({
      where: { slug: model.providerSlug },
      select: { slug: true, isActive: true },
    }),
    modelUses(model, { acrossOrgs: platform }),
  ]);

  const { replacement, ...row } = model;
  log.info('Provider model fetched', { modelId: id });
  return successResponse({
    ...row,
    configured: !!config,
    configuredActive: config?.isActive ?? false,
    // §136 t-1064 / t-1065: where it is in its retirement, and what uses it.
    lifecycle: { state: modelLifecycleState(model), replacement },
    uses,
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

    // The split prices are a pair on the row as saved, not just in the body:
    // half a price records the other half of every turn at $0 (t-774).
    const nextInput =
      body.inputCostPerMillionTokens !== undefined
        ? body.inputCostPerMillionTokens
        : current.inputCostPerMillionTokens;
    const nextOutput =
      body.outputCostPerMillionTokens !== undefined
        ? body.outputCostPerMillionTokens
        : current.outputCostPerMillionTokens;
    if (isHalfPrice(nextInput, nextOutput)) throw pricePairError(nextInput);

    // A replacement is only meaningful beside a retirement date. Clearing the
    // date clears the replacement with it; naming one without a date is refused.
    const nextRetiresAt = body.retiresAt !== undefined ? body.retiresAt : current.retiresAt;
    const nextReplacementId =
      body.replacementId !== undefined
        ? body.replacementId
        : body.retiresAt === null
          ? null
          : current.replacementId;
    if (nextReplacementId !== null && nextRetiresAt === null) {
      throw new ValidationError('Set a retirement date before naming a replacement', {
        replacementId: ['Set a retirement date before naming a replacement'],
      });
    }
    // Checked when this save changes something the rule reads on THIS row: the
    // replacement, or the provider or capabilities. Compared with the saved
    // row, not with what the body carries: the edit form sends all three on
    // every save, and a stored replacement that has since stopped qualifying
    // (it was turned off, or is retiring itself) must not block an unrelated
    // edit. Edits to the replacement's own row are not checked here, so a
    // stored replacement can go stale; the move (t-1066) checks again before
    // it writes anything.
    const nextProviderSlug = body.providerSlug ?? current.providerSlug;
    const nextCapabilities = body.capabilities ?? current.capabilities;
    const ruleInputsChanged =
      nextReplacementId !== current.replacementId ||
      nextProviderSlug !== current.providerSlug ||
      !sameMembers(nextCapabilities, current.capabilities);
    if (nextReplacementId !== null && ruleInputsChanged) {
      const candidate = await findReplacementById(nextReplacementId);
      const refusal = candidate
        ? checkReplacement(
            { id, providerSlug: nextProviderSlug, capabilities: nextCapabilities },
            candidate
          )
        : `Provider model ${nextReplacementId} not found`;
      if (refusal !== null) {
        throw new ValidationError(refusal, { replacementId: [refusal] });
      }
    }

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
    if (body.inputCostPerMillionTokens !== undefined)
      data.inputCostPerMillionTokens = body.inputCostPerMillionTokens;
    if (body.outputCostPerMillionTokens !== undefined)
      data.outputCostPerMillionTokens = body.outputCostPerMillionTokens;
    if (body.hasFreeTier !== undefined) data.hasFreeTier = body.hasFreeTier;
    if (body.local !== undefined) data.local = body.local;
    if (body.quality !== undefined) data.quality = body.quality;
    if (body.strengths !== undefined) data.strengths = body.strengths;
    if (body.setup !== undefined) data.setup = body.setup;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.retiresAt !== undefined) data.retiresAt = body.retiresAt;
    if (nextReplacementId !== current.replacementId) {
      data.replacement =
        nextReplacementId === null ? { disconnect: true } : { connect: { id: nextReplacementId } };
    }
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

      // The edit form sends every field on every save, so a save that
      // changed nothing still reaches here; it writes no audit row.
      const changes = computeChanges(current, updated, { ignoreKeys: ['updatedAt', 'createdAt'] });
      if (changes) {
        logAdminAction({
          userId: session.user.id,
          action: 'provider_model.update',
          entityType: 'provider_model',
          entityId: id,
          entityName: updated.name,
          changes,
          clientIp: getClientIP(request),
        });
      }

      return successResponse(updated);
    } catch (err) {
      // Two PATCHes can each pass the check above against the same saved row
      // and together leave half a price; the database refuses the second
      // (`ai_provider_model_price_pair`, raised as P2039 under the driver
      // adapter). Same answer as the check gives.
      if (err instanceof Error && err.message.includes(PRICE_PAIR_CONSTRAINT)) {
        throw pricePairError(null);
      }
      if (isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.providerModelSlug)) {
        throw new ValidationError(`Provider model with slug '${body.slug}' already exists`, {
          slug: ['Slug is already in use'],
        });
      }
      if (isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.providerModelPair)) {
        throw new ValidationError('This provider already has a model with that model id', {
          modelId: ['Already in use for this provider'],
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
    // strings; workflows pin via `step.config.modelOverride`, a model pin
    // (§136 t-1068): `provider::model`, or a bare id resolved from the model
    // registry at runtime. A workflow pinning by bare id blocks the delete
    // even when another provider offers the id, unlike a saved setting: the
    // registry holds one entry per id and keeps a deleted row's until the
    // process restarts, so the id may still resolve to this row's provider.
    //
    // In every org (t-731): the model is global config, so another org's
    // agents and workflows refuse the delete too. Only the caller's own are
    // named; another org's are a count.
    //
    // And while a saved install setting names it (§136 t-1065): a saved task
    // default or the confidential-message model would name a row that no
    // longer exists, and the active embedding model would be cleared under
    // every org's vectors. A default the system only suggests does not block
    // it: nobody chose it, and the suggestion is recomputed from the registry.
    // (The registry may still list a deleted model's id, so the suggestion is
    // not guaranteed to move; config health's retired check names that case.)
    const usage = await modelUses(current);
    const agentCount = usage.agents.length + usage.otherOrgAgents;
    const workflowCount = usage.workflows.length + usage.otherOrgWorkflows;
    // A saved default naming the model by id alone keeps working when another
    // active row offers the id, so it does not block the delete then.
    const savedSettings = usage.settings.filter(
      (pin) => pin.source === 'saved' && !(pin.byIdOnly && usage.sharedWith.length > 0)
    );

    // And while the app reports a use of it (§136 t-1067): its own code or
    // tables would name a row that no longer exists. The delete cannot be
    // undone, so a report that failed refuses it too (below): the model is
    // not known to be unused.
    const appCount = usage.appPins.length + usage.otherOrgAppPins;

    if (agentCount > 0 || workflowCount > 0 || savedSettings.length > 0 || appCount > 0) {
      log.info('Provider model delete refused — model in use', {
        modelId: id,
        slug: current.slug,
        agentCount,
        workflowCount,
        otherOrgAgentCount: usage.otherOrgAgents,
        otherOrgWorkflowCount: usage.otherOrgWorkflows,
        savedSettings: savedSettings.map((pin) => pin.slot),
        appCount,
      });
      return errorResponse(buildInUseMessage(current.name, usage, savedSettings.length, appCount), {
        code: 'MODEL_IN_USE',
        status: 409,
        details: {
          agents: usage.agents,
          workflows: usage.workflows,
          otherOrgAgentCount: usage.otherOrgAgents,
          otherOrgWorkflowCount: usage.otherOrgWorkflows,
          settings: savedSettings.map((pin) => pin.slot),
          // Only when the app reports a use: with nothing registered the
          // answer is as it was before the seam.
          ...(appCount > 0
            ? { appPins: usage.appPins, otherOrgAppPinCount: usage.otherOrgAppPins }
            : {}),
        },
      });
    }
    if (usage.appPinsUnavailable) {
      log.warn('Provider model delete refused — the app’s uses could not be read', {
        modelId: id,
        slug: current.slug,
      });
      return errorResponse(
        `Cannot delete model "${current.name}" — the app’s own uses of it could not all be read, so it may still be in use. Try again once the app’s report works; the server log says why it failed.`,
        { code: 'MODEL_USES_UNREADABLE', status: 409 }
      );
    }

    // Models naming this one as their replacement lose it (`ON DELETE SET
    // NULL`), which no other row records; the delete's row names them.
    const replacing = await prisma.aiProviderModel.findMany({
      where: { replacementId: id },
      select: { id: true, name: true },
    });

    await prisma.aiProviderModel.delete({ where: { id } });

    invalidateModelCache();

    logAdminAction({
      userId: session.user.id,
      action: 'provider_model.delete',
      entityType: 'provider_model',
      entityId: id,
      entityName: current.name,
      metadata: {
        providerSlug: current.providerSlug,
        modelId: current.modelId,
        ...(replacing.length > 0 ? { replacementClearedFor: replacing } : {}),
      },
      clientIp: getClientIP(request),
    });

    log.info('Provider model deleted', {
      modelId: id,
      slug: current.slug,
      adminId: session.user.id,
    });

    return successResponse({ id, deleted: true });
  },
  { writesSharedSettings: true }
);

/** Whether two capability lists hold the same members, in any order. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((c) => right.has(c));
}

function buildInUseMessage(
  modelName: string,
  usage: ProviderModelUsage,
  savedSettings: number,
  appUses: number = 0
): string {
  const agents = usage.agents.length + usage.otherOrgAgents;
  const workflows = usage.workflows.length + usage.otherOrgWorkflows;
  const elsewhere = usage.otherOrgAgents + usage.otherOrgWorkflows;
  const parts: string[] = [];
  if (agents > 0) parts.push(`${agents} active agent${agents === 1 ? '' : 's'}`);
  if (workflows > 0) parts.push(`${workflows} active workflow${workflows === 1 ? '' : 's'}`);
  // Other organisations hold agents and workflows; settings are the install's.
  if (elsewhere > 0) parts[parts.length - 1] += ` (${elsewhere} of them in other organisations)`;
  if (savedSettings > 0) {
    parts.push(`${savedSettings} saved setting${savedSettings === 1 ? '' : 's'}`);
  }
  if (appUses > 0) parts.push(`${appUses} use${appUses === 1 ? '' : 's'} the app reports`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const one = agents + workflows + savedSettings + appUses === 1;
  const appNote = appUses > 0 ? ' The app moves its own uses itself.' : '';
  return `Cannot delete model "${modelName}" — ${list} still reference${one ? 's' : ''} it. Re-point them to a different model first.${appNote}`;
}
