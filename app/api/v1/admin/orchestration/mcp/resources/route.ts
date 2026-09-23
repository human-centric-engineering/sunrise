/**
 * Admin MCP — Exposed Resources
 *
 * GET  /api/v1/admin/orchestration/mcp/resources — list exposed resources
 * POST /api/v1/admin/orchestration/mcp/resources — create exposed resource
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { Prisma } from '@prisma/client';
import {
  clearMcpResourceCache,
  isDispatchableMcpResourceType,
  isAllowedMcpResourceUri,
  isUriSchemeValidForResourceType,
  mcpResourceUriSchemeFor,
  listAllowedMcpResourceUriSchemes,
} from '@/lib/orchestration/mcp';
import { ValidationError } from '@/lib/api/errors';
import {
  createExposedResourceSchema,
  listExposedResourcesQuerySchema,
} from '@/lib/validations/mcp';

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);
  const { page, limit, isEnabled, resourceType } = validateQueryParams(
    new URL(request.url).searchParams,
    listExposedResourcesQuerySchema
  );

  const where: Record<string, unknown> = {};
  if (isEnabled !== undefined) where.isEnabled = isEnabled;
  if (resourceType) where.resourceType = resourceType;

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.mcpExposedResource.findMany({
      where,
      skip,
      take: limit,
      orderBy: { name: 'asc' },
    }),
    prisma.mcpExposedResource.count({ where }),
  ]);

  log.info('MCP exposed resources listed', { count: items.length, total });
  return paginatedResponse(items, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createExposedResourceSchema);

  // Membership checks live here rather than in the Zod schema: the schema
  // module is imported by client components, and the registry reaches the
  // fork's `lib/app/mcp-resources.ts` (#462 realm split). See the docblock on
  // `resourceTypeSchema`.
  //
  // Together these reject a row that could never serve a read — which is what
  // #540 reported: an inserted row whose type has no handler dispatches to
  // `null` and logs "no handler for type", long after whoever created it has
  // stopped looking.
  if (!isAllowedMcpResourceUri(body.uri)) {
    const schemes = listAllowedMcpResourceUriSchemes()
      .map((s) => `${s}://`)
      .join(', ');
    throw new ValidationError(`URI must use a registered scheme (${schemes})`, {
      uri: [`Allowed schemes: ${schemes}`],
    });
  }

  if (!isDispatchableMcpResourceType(body.resourceType)) {
    throw new ValidationError(`No handler is registered for resourceType '${body.resourceType}'`, {
      resourceType: [
        'Register a handler with registerMcpResourceHandler() from lib/app/mcp-resources.ts first.',
      ],
    });
  }

  // The two checks above are independent, and independent is not enough: with
  // `project_plan` registered under `hub`, a URI of `sunrise://projects/x/plan`
  // satisfies both and then serves fork data under the platform's own scheme to
  // every MCP client that lists it. Requiring `uriScheme` at registration only
  // means anything if the pair is enforced here.
  if (!isUriSchemeValidForResourceType(body.uri, body.resourceType)) {
    const expected = mcpResourceUriSchemeFor(body.resourceType);
    throw new ValidationError(
      `resourceType '${body.resourceType}' is registered under the '${expected}://' scheme`,
      { uri: [`Must use ${expected}://`] }
    );
  }

  const resource = await prisma.mcpExposedResource.create({
    data: {
      uri: body.uri,
      name: body.name,
      description: body.description,
      mimeType: body.mimeType,
      resourceType: body.resourceType,
      isEnabled: body.isEnabled,
      handlerConfig: body.handlerConfig
        ? (body.handlerConfig as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
  });

  clearMcpResourceCache();

  log.info('MCP exposed resource created', {
    adminId: session.user.id,
    resourceId: resource.id,
    uri: resource.uri,
  });

  return successResponse(resource, undefined, { status: 201 });
});
