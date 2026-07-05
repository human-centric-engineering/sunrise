/**
 * Admin MCP — API Key by ID
 *
 * PATCH  /api/v1/admin/orchestration/mcp/keys/:id — update (revoke, rename, change expiry)
 * DELETE /api/v1/admin/orchestration/mcp/keys/:id — permanently delete key
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { updateApiKeySchema } from '@/lib/validations/mcp';
import { cuidSchema } from '@/lib/validations/common';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  cuidSchema.parse(id);

  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, updateApiKeySchema);

  // Audited + client-facing projection. Deliberately excludes `keyHash` (a
  // credential-derived value that must never enter the audit diff) and the
  // system columns `scopedAgentId` / `createdBy`. Fetching `existing` and
  // `updated` through the SAME projection keeps the change diff symmetric — so
  // no column present on one side but not the other is recorded as a spurious
  // `→ undefined` change (which previously leaked `keyHash` into the audit log
  // on every PATCH). See issue #388.
  const keySelect = {
    id: true,
    name: true,
    keyPrefix: true,
    scopes: true,
    scope: true,
    isActive: true,
    expiresAt: true,
    lastUsedAt: true,
    rateLimitOverride: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.McpApiKeySelect;

  const existing = await prisma.mcpApiKey.findUnique({ where: { id }, select: keySelect });
  if (!existing) throw new NotFoundError('API key not found');

  // `scope` is a `Json?` column: JS `null` can't clear it (Prisma requires the
  // `DbNull` sentinel), and `undefined` must leave it untouched. Everything else
  // in `body` passes through unchanged.
  const { scope, ...rest } = body;
  const data: Prisma.McpApiKeyUpdateInput = {
    ...rest,
    ...(scope !== undefined ? { scope: scope === null ? Prisma.DbNull : scope } : {}),
  };

  const updated = await prisma.mcpApiKey.update({
    where: { id },
    data,
    select: keySelect,
  });

  log.info('MCP API key updated', {
    adminId: session.user.id,
    keyId: id,
    changedKeys: Object.keys(body),
  });

  logAdminAction({
    userId: session.user.id,
    action: 'mcp_api_key.update',
    entityType: 'mcp_api_key',
    entityId: id,
    entityName: updated.name,
    // `updatedAt` is `@updatedAt` — it bumps on every `update()`, so ignore it
    // or every PATCH would record a spurious timestamp change. `createdAt` is
    // immutable (never diffs) but is listed too for parity with the other admin
    // routes' audit diffs.
    changes: computeChanges(existing, updated, { ignoreKeys: ['updatedAt', 'createdAt'] }),
    clientIp: clientIP,
  });

  return successResponse(updated);
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  cuidSchema.parse(id);

  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);

  const existing = await prisma.mcpApiKey.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('API key not found');

  await prisma.mcpApiKey.delete({ where: { id } });

  log.info('MCP API key deleted', {
    adminId: session.user.id,
    keyId: id,
    keyPrefix: existing.keyPrefix,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'mcp_api_key.delete',
    entityType: 'mcp_api_key',
    entityId: id,
    entityName: existing.name,
    metadata: { keyPrefix: existing.keyPrefix },
    clientIp: clientIP,
  });

  return successResponse({ id, deleted: true });
});
