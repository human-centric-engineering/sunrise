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

  return successResponse({ id, isActive: false });
});
