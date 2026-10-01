/**
 * Admin Orchestration — Single provider (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/providers/:id — row + `apiKeyPresent` boolean
 * PATCH  /api/v1/admin/orchestration/providers/:id — update, clears cached instance
 * DELETE /api/v1/admin/orchestration/providers/:id           — soft delete (`isActive=false`)
 * DELETE /api/v1/admin/orchestration/providers/:id?permanent=true
 *        — hard delete; refuses with 409 if any agent or cost log references
 *          the slug (chat binding, fallback list, or historical cost rows), or
 *          any org's approved providers name it (§120 t-742). A PATCH that
 *          renames the slug is refused for the same org grants.
 *
 * Authentication: Admin role required.
 *
 * Secret safety: the env-var *value* is never returned or logged. Only
 * `apiKeyPresent: boolean` is exposed, from `hasProviderKey(row)` — the
 * credential seam's answer (§120 t-744), by default whether the row's env var
 * is set.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { clearCache as clearProviderCache } from '@/lib/orchestration/llm/provider-manager';
import { hasProviderKey } from '@/lib/orchestration/llm/provider-credentials';
import { updateProviderConfigSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { orgsApprovingProvider } from '@/lib/tenancy/org-settings';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'provider id' });

  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) throw new NotFoundError(`Provider ${id} not found`);

  log.info('Provider fetched', { providerId: id });
  return successResponse({
    ...provider,
    apiKeyPresent: await hasProviderKey(provider),
  });
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'provider id' });

  const current = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Provider ${id} not found`);

  const body = await validateRequestBody(request, updateProviderConfigSchema);

  // An org's provider grant names the slug (§120 t-742). Renaming a row an
  // org is approved for would strand the grant, and hand it to whichever row
  // takes the old slug next — a provider nobody approved. Revoke first.
  if (body.slug !== undefined && body.slug !== current.slug) {
    const approvingOrgs = await orgsApprovingProvider(current.slug);
    if (approvingOrgs.length > 0) {
      throw new ConflictError(
        `Cannot rename '${current.slug}' — ${approvingOrgs.length} org${
          approvingOrgs.length === 1 ? ' is' : 's are'
        } approved for it by slug. Remove it from their approved providers first.`,
        { slug: current.slug, approvingOrgs }
      );
    }
  }

  const data: Prisma.AiProviderConfigUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.providerType !== undefined) data.providerType = body.providerType;
  if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl;
  if (body.apiKeyEnvVar !== undefined) data.apiKeyEnvVar = body.apiKeyEnvVar;
  if (body.isLocal !== undefined) data.isLocal = body.isLocal;
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.jurisdiction !== undefined) data.jurisdiction = body.jurisdiction;
  if (body.metadata !== undefined) data.metadata = body.metadata;
  if (body.timeoutMs !== undefined) data.timeoutMs = body.timeoutMs;
  if (body.maxRetries !== undefined) data.maxRetries = body.maxRetries;

  try {
    const updated = await prisma.aiProviderConfig.update({ where: { id }, data });

    // Evict cached provider instances under both the old and (possibly new) slug.
    clearProviderCache(current.slug);
    if (updated.slug !== current.slug) clearProviderCache(updated.slug);

    log.info('Provider updated', {
      providerId: id,
      adminId: session.user.id,
      fieldsChanged: Object.keys(data),
    });

    logAdminAction({
      userId: session.user.id,
      action: 'provider.update',
      entityType: 'provider',
      entityId: id,
      entityName: updated.name,
      changes: computeChanges(current, updated, { ignoreKeys: ['updatedAt', 'createdAt'] }),
      clientIp: clientIP,
    });

    return successResponse({
      ...updated,
      apiKeyPresent: await hasProviderKey(updated),
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ValidationError(
        `Provider with slug '${body.slug}' or name '${body.name}' already exists`,
        {
          slug: ['Slug or name is already in use'],
        }
      );
    }
    throw err;
  }
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'provider id' });
  const permanent = new URL(request.url).searchParams.get('permanent') === 'true';

  const current = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Provider ${id} not found`);

  // ── Permanent delete path ─────────────────────────────────────────
  // Refuse if any agent (primary or fallback) or historical cost row
  // still references the slug. Soft-delete keeps those references
  // valid; hard-delete would orphan them. The operator can either
  // re-point the agents/clear the cost log first, or stick with the
  // soft-delete via the default DELETE.
  if (permanent) {
    const [primaryAgentCount, fallbackAgentCount, costLogCount, approvingOrgs] = await Promise.all([
      prisma.aiAgent.count({ where: { provider: current.slug } }),
      prisma.aiAgent.count({ where: { fallbackProviders: { has: current.slug } } }),
      prisma.aiCostLog.count({ where: { provider: current.slug } }),
      // An org grant names the slug too (§120 t-742): deleting the row and
      // re-creating the slug would hand the grant to a different provider.
      orgsApprovingProvider(current.slug),
    ]);

    const totalAgentRefs = primaryAgentCount + fallbackAgentCount;

    if (approvingOrgs.length > 0) {
      log.info('Permanent delete blocked by org grants', {
        providerId: id,
        slug: current.slug,
        approvingOrgs,
      });
      throw new ConflictError(
        `Cannot permanently delete '${current.slug}' — ${approvingOrgs.length} org${
          approvingOrgs.length === 1 ? ' is' : 's are'
        } approved for it. Remove it from their approved providers first, or deactivate instead.`,
        { slug: current.slug, approvingOrgs }
      );
    }

    if (totalAgentRefs > 0 || costLogCount > 0) {
      log.info('Permanent delete blocked by references', {
        providerId: id,
        slug: current.slug,
        primaryAgentCount,
        fallbackAgentCount,
        costLogCount,
      });
      throw new ConflictError(
        `Cannot permanently delete '${current.slug}' — it is referenced by ${totalAgentRefs} agent${
          totalAgentRefs === 1 ? '' : 's'
        } and ${costLogCount} cost log row${costLogCount === 1 ? '' : 's'}. Re-point or clear those first, or deactivate instead.`,
        {
          slug: current.slug,
          primaryAgentCount,
          fallbackAgentCount,
          costLogCount,
        }
      );
    }

    await prisma.aiProviderConfig.delete({ where: { id } });
    clearProviderCache(current.slug);

    log.info('Provider permanently deleted', {
      providerId: id,
      slug: current.slug,
      adminId: session.user.id,
    });
    logAdminAction({
      userId: session.user.id,
      action: 'provider.delete',
      entityType: 'provider',
      entityId: id,
      entityName: current.name,
      clientIp: clientIP,
      metadata: { permanent: true },
    });

    return successResponse({ id, deleted: true, permanent: true });
  }

  // ── Soft delete (default) ─────────────────────────────────────────
  if (!current.isActive) {
    log.info('Provider already inactive, skipping soft-delete', { providerId: id });
    logAdminAction({
      userId: session.user.id,
      action: 'provider.delete',
      entityType: 'provider',
      entityId: id,
      entityName: current.name,
      clientIp: clientIP,
      metadata: { alreadyInactive: true },
    });
    return successResponse({ id, isActive: false });
  }

  const updated = await prisma.aiProviderConfig.update({
    where: { id },
    data: { isActive: false },
  });

  clearProviderCache(current.slug);

  log.info('Provider soft-deleted', {
    providerId: id,
    slug: updated.slug,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'provider.delete',
    entityType: 'provider',
    entityId: id,
    entityName: updated.name,
    clientIp: clientIP,
  });

  return successResponse({ id, isActive: false });
});
