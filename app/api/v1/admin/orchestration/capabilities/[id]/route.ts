/**
 * Admin Orchestration — Single capability (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/capabilities/:id
 * PATCH  /api/v1/admin/orchestration/capabilities/:id
 * DELETE /api/v1/admin/orchestration/capabilities/:id
 *   - Soft delete: sets `isActive = false`. Hard delete would cascade
 *     across every `AiAgentCapability` pivot row and potentially orphan
 *     historical tool-call logs.
 *
 * Both PATCH and DELETE call `capabilityDispatcher.clearCache()` on
 * success so the dispatcher re-reads registrations on the next call.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import {
  capabilityFunctionDefinitionSchema,
  updateCapabilitySchema,
} from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'capability id' });

  const capability = await prisma.aiCapability.findUnique({ where: { id } });
  if (!capability) throw new NotFoundError(`Capability ${id} not found`);

  log.info('Capability fetched', { capabilityId: id });
  return successResponse(capability);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'capability id' });

  const current = await prisma.aiCapability.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Capability ${id} not found`);

  const body = await validateRequestBody(request, updateCapabilitySchema);

  // When executionHandler is changed without executionType in the body,
  // validate URL format against the existing executionType from the DB.
  if (body.executionHandler && !body.executionType) {
    const effectiveType = current.executionType;
    if (effectiveType === 'api' || effectiveType === 'webhook') {
      try {
        new URL(body.executionHandler);
      } catch {
        throw new ValidationError(
          'Execution handler must be a valid URL for api and webhook types',
          { executionHandler: ['Must be a valid URL'] }
        );
      }
    }
  }

  // `functionDefinition.name` must equal `slug` — dispatch resolves the name a
  // model emits AS the slug, so divergence means a capability is checked by the
  // #476 tool-call guard under one identity and executed under another (#509).
  // A PATCH can move either half alone, which the schema cannot decide from the
  // body, so compare the EFFECTIVE pair against the stored row — same shape as
  // the executionHandler/executionType case above.
  if (body.slug !== undefined || body.functionDefinition !== undefined) {
    const storedFn = capabilityFunctionDefinitionSchema.safeParse(current.functionDefinition);
    const effectiveSlug = body.slug ?? current.slug;
    // An unparseable stored definition leaves nothing to compare against. The
    // row is already inert — `getCapabilityDefinitions` skips it — so let the
    // write through rather than blocking a PATCH that may be repairing it.
    const effectiveName = body.functionDefinition
      ? body.functionDefinition.name
      : storedFn.success
        ? storedFn.data.name
        : undefined;

    if (effectiveName !== undefined && effectiveName !== effectiveSlug) {
      throw new ValidationError('functionDefinition.name must equal slug', {
        'functionDefinition.name': [`Must equal the capability slug ("${effectiveSlug}")`],
      });
    }
  }

  // System capabilities cannot be deactivated via PATCH (equivalent to deletion).
  if (current.isSystem && body.isActive === false) {
    throw new ForbiddenError('System capabilities cannot be deactivated');
  }

  const data: Prisma.AiCapabilityUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.description !== undefined) data.description = body.description;
  if (body.category !== undefined) data.category = body.category;
  if (body.functionDefinition !== undefined) {
    data.functionDefinition = body.functionDefinition as unknown as Prisma.InputJsonValue;
  }
  if (body.executionType !== undefined) data.executionType = body.executionType;
  if (body.executionHandler !== undefined) data.executionHandler = body.executionHandler;
  if (body.executionConfig !== undefined) {
    data.executionConfig = body.executionConfig as Prisma.InputJsonValue;
  }
  if (body.requiresApproval !== undefined) data.requiresApproval = body.requiresApproval;
  if (body.approvalTimeoutMs !== undefined) data.approvalTimeoutMs = body.approvalTimeoutMs;
  if (body.rateLimit !== undefined) data.rateLimit = body.rateLimit;
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.metadata !== undefined) {
    data.metadata = body.metadata;
  }

  try {
    const capability = await prisma.aiCapability.update({ where: { id }, data });

    capabilityDispatcher.clearCache();

    log.info('Capability updated', {
      capabilityId: id,
      adminId: session.user.id,
      fieldsChanged: Object.keys(data),
    });

    logAdminAction({
      userId: session.user.id,
      action: 'capability.update',
      entityType: 'capability',
      entityId: id,
      entityName: capability.name,
      changes: computeChanges(current, capability),
      clientIp: clientIP,
    });

    return successResponse(capability);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ValidationError(`Capability with slug '${body.slug}' already exists`, {
        slug: ['Slug is already in use'],
      });
    }
    throw err;
  }
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'capability id' });

  const current = await prisma.aiCapability.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Capability ${id} not found`);

  if (current.isSystem) {
    throw new ForbiddenError('System capabilities cannot be deleted');
  }

  const capability = await prisma.aiCapability.update({
    where: { id },
    data: { isActive: false },
  });

  capabilityDispatcher.clearCache();

  log.info('Capability soft-deleted', {
    capabilityId: id,
    slug: capability.slug,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'capability.delete',
    entityType: 'capability',
    entityId: id,
    entityName: capability.name,
    clientIp: clientIP,
  });

  return successResponse({ id, isActive: false });
});
