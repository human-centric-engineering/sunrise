/**
 * Admin Orchestration — Single provider (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/providers/:id — row + `apiKeyPresent` boolean
 * PATCH  /api/v1/admin/orchestration/providers/:id — update, clears cached instance
 * DELETE /api/v1/admin/orchestration/providers/:id — soft delete (`isActive=false`)
 *
 * Authentication: Admin role required.
 *
 * Secret safety: the env-var *value* is never returned or logged. Only
 * `apiKeyPresent: boolean` is exposed, derived from
 * `isApiKeyEnvVarSet(row.apiKeyEnvVar)`.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import {
  clearCache as clearProviderCache,
  isApiKeyEnvVarSet,
} from '@/lib/orchestration/llm/provider-manager';
import { updateProviderConfigSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

function parseProviderId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid provider id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseProviderId(rawId);

  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) throw new NotFoundError(`Provider ${id} not found`);

  log.info('Provider fetched', { providerId: id });
  return successResponse({
    ...provider,
    apiKeyPresent: isApiKeyEnvVarSet(provider.apiKeyEnvVar),
  });
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseProviderId(rawId);

  const current = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Provider ${id} not found`);

  const body = await validateRequestBody(request, updateProviderConfigSchema);

  const data: Prisma.AiProviderConfigUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.providerType !== undefined) data.providerType = body.providerType;
  if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl;
  if (body.apiKeyEnvVar !== undefined) data.apiKeyEnvVar = body.apiKeyEnvVar;
  if (body.isLocal !== undefined) data.isLocal = body.isLocal;
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.metadata !== undefined) data.metadata = body.metadata as Prisma.InputJsonValue;
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
      changes: computeChanges(
        current as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>
      ),
      clientIp: clientIP,
    });

    return successResponse({
      ...updated,
      apiKeyPresent: isApiKeyEnvVarSet(updated.apiKeyEnvVar),
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
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseProviderId(rawId);

  const current = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Provider ${id} not found`);

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
