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
import { capabilityDispatcher, changedSeedOwnedFields } from '@/lib/orchestration/capabilities';
import {
  capabilityFunctionDefinitionSchema,
  updateCapabilitySchema,
} from '@/lib/validations/orchestration';
import { mcpToolNameSchema } from '@/lib/validations/mcp';
import { clearMcpToolCache, broadcastMcpToolsChanged } from '@/lib/orchestration/mcp';
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

/**
 * The function name a write is about to displace, or `null` if it displaces
 * nothing. Used to pin the capability's MCP tool name before it moves (#509).
 */
function displacedFunctionName(
  storedFunctionDefinition: unknown,
  nextName: string | undefined
): string | null {
  if (nextName === undefined) return null;

  const stored = capabilityFunctionDefinitionSchema.safeParse(storedFunctionDefinition);
  if (!stored.success) return null;

  return stored.data.name === nextName ? null : stored.data.name;
}

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'capability id' });

  const current = await prisma.aiCapability.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Capability ${id} not found`);

  const body = await validateRequestBody(request, updateCapabilitySchema);

  // ── System-capability guards ────────────────────────────────────────────
  // These run before the field-shape checks below so a system row gets the
  // accurate answer rather than an incidental one. Renaming a built-in's slug,
  // for instance, trips the `functionDefinition.name must equal slug` check on
  // its way past — a 400 about a field the operator did not touch, when the
  // real answer is that the slug is not theirs to change.

  // System capabilities cannot be deactivated via PATCH (equivalent to deletion).
  if (current.isSystem && body.isActive === false) {
    throw new ForbiddenError('System capabilities cannot be deactivated');
  }

  // A system capability's `functionDefinition`, `executionType` and
  // `executionHandler` are re-applied by its seed on every deploy whose seed
  // file hash changes, and its `slug` is the key that upsert matches on. So
  // accepting a write to any of them means accepting an edit that does not
  // survive — reverted with no audit entry, or (for `slug`) leaving a second
  // row for one built-in. Refuse instead, naming the fields.
  //
  // `changedSeedOwnedFields` compares VALUES, not presence: the capability form
  // PATCHes the whole form on every save, so a presence check would 403 an
  // admin who only edited the description. See `seed-owned.ts` for both traps.
  if (current.isSystem) {
    const seedOwned = changedSeedOwnedFields(current, body);
    if (seedOwned.length > 0) {
      throw new ForbiddenError(
        `System capabilities are seeded from code — ${seedOwned.join(', ')} cannot be changed here. ` +
          `Edit the capability's seed unit in prisma/seeds/ instead; every other field on this capability remains editable.`
      );
    }
  }

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

  // A write that moves `functionDefinition.name` also moves the capability's
  // MCP tool name, because `tools/list` advertises `customName ?? name` and
  // `tools/call` resolves an incoming call by whatever was advertised. Since
  // #509 forces the name to equal the slug, and every capability created
  // through the admin UI before that release diverged by default
  // (`search-web` / `search_web`), the first ordinary save of such a row would
  // silently rename its public tool and leave external clients calling a name
  // that no longer resolves.
  //
  // Pin the OLD name into `customName` first. `customName` takes precedence
  // over the function name and is never touched by the invariant, so the
  // external contract stays exactly where it was while the internal one is
  // repaired. Only rows that have not already set an override are touched.
  const displacedName = displacedFunctionName(
    current.functionDefinition,
    body.functionDefinition?.name
  );
  // A name that cannot legally live in `customName` (`^[a-z][a-z0-9_]*$` — no
  // hyphens, must start with a letter) is deliberately NOT pinned: writing it
  // would satisfy this moment and then fail validation the next time an admin
  // touched the MCP row, on a field they had not changed. The rename still
  // happens, so it is logged — but inside the transaction, below, because
  // logging it here announced a broken tool name for writes that then got
  // rejected by the system-capability guard or a slug collision, sending
  // whoever investigated to a capability that was never modified.
  const renamedFrom =
    displacedName && mcpToolNameSchema.safeParse(displacedName).success ? displacedName : null;
  const unpinnableName = displacedName && !renamedFrom ? displacedName : null;

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
    const capability = await prisma.$transaction(async (tx) => {
      // Nothing below concerns a capability that was never published over
      // MCP. Both warnings used to fire regardless, announcing a moved tool
      // name for a capability with no tool — sending whoever read the log to
      // investigate an integration that does not exist.
      const exposed = displacedName
        ? await tx.mcpExposedTool.findUnique({
            where: { capabilityId: id },
            select: { id: true },
          })
        : null;

      if (exposed && unpinnableName) {
        log.warn('Capability rename moves an MCP tool name that cannot be pinned', {
          capabilityId: id,
          displacedName: unpinnableName,
          newFunctionName: body.functionDefinition?.name,
        });
      }
      if (exposed && renamedFrom) {
        // `customName` has no unique constraint, and `callMcpTool` resolves an
        // incoming call with `tools.find(t => t.name === toolName)` — first
        // match wins. Pinning a name another exposed tool already advertises
        // would therefore make every call to it dispatch to whichever row the
        // query returned first, silently running the wrong capability. Refuse
        // rather than create that: the rename proceeds unpinned and is logged,
        // which breaks one client's tool name loudly instead of misrouting two.
        // Compare against what each other tool ACTUALLY advertises, which is
        // `customName ?? functionDefinition.name`. Approximating the null case
        // with the capability's slug would miss precisely the legacy divergent
        // rows this pin exists for. `functionDefinition` is a JSON column, so
        // the comparison happens here rather than in the query; the candidate
        // set is only the exposed tools, which is small by construction.
        // Two different questions, so two different filters.
        //
        // An explicit `customName` is a CLAIM on that name, live or not: the
        // row keeps it when re-enabled, and nothing enforces uniqueness at the
        // enable path or in the schema. Pinning the same string alongside it
        // would leave a duplicate lying in wait, and `callMcpTool` resolves
        // first-match-wins. So explicit names are checked across every row.
        //
        // A DERIVED name (null `customName`) only exists while the row is
        // advertised, and is re-derived from whatever the capability says at
        // the time — so only enabled rows with an active capability can
        // collide on one. Checking derived names on disabled rows is what
        // caused the previous over-refusal, where a tool advertising nothing
        // blocked the pin and let the protected name move anyway.
        const others = await tx.mcpExposedTool.findMany({
          where: {
            capabilityId: { not: id },
            OR: [
              { customName: { not: null } },
              { customName: null, isEnabled: true, capability: { isActive: true } },
            ],
          },
          select: {
            id: true,
            customName: true,
            capability: { select: { functionDefinition: true } },
          },
        });
        const clash = others.find((tool) => {
          if (tool.customName !== null) return tool.customName === renamedFrom;
          const parsedOther = capabilityFunctionDefinitionSchema.safeParse(
            tool.capability.functionDefinition
          );
          return parsedOther.success && parsedOther.data.name === renamedFrom;
        });
        if (clash) {
          log.warn('Not pinning an MCP tool name that another exposed tool already advertises', {
            capabilityId: id,
            displacedName: renamedFrom,
            conflictingToolId: clash.id,
          });
          return tx.aiCapability.update({ where: { id }, data });
        }

        const pinned = await tx.mcpExposedTool.updateMany({
          where: { capabilityId: id, customName: null },
          data: { customName: renamedFrom },
        });
        if (pinned.count > 0) {
          log.info('Pinned the MCP tool name before a capability rename', {
            capabilityId: id,
            customName: renamedFrom,
            newFunctionName: body.functionDefinition?.name,
          });
        }
      }
      return tx.aiCapability.update({ where: { id }, data });
    });

    capabilityDispatcher.clearCache();
    // The MCP tool list caches for 5 minutes and serves both `tools/list` and
    // `tools/call`. A capability PATCH rewrites `functionDefinition.parameters`,
    // which IS the advertised `inputSchema` — so without this an admin who
    // tightens a parameter leaves MCP clients fetching the old schema for up to
    // five minutes, sending args the live dispatcher then rejects. Every writer
    // under `/mcp/tools` already pairs its write with this; this route became a
    // writer of MCP state when it started pinning `customName` (#509).
    clearMcpToolCache();
    broadcastMcpToolsChanged();

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
  // `isActive` is exactly what `loadGlobalTools` filters on, so a soft delete
  // changes the MCP surface as surely as a PATCH does — and the identical
  // state change sent as `PATCH { isActive: false }` (what the capabilities
  // table sends) already clears it. Without this, `tools/list` advertises the
  // deleted tool for up to five minutes and `tools/call` resolves it before
  // failing at dispatch.
  clearMcpToolCache();
  broadcastMcpToolsChanged();

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
