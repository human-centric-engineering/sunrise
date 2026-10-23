/**
 * Admin Orchestration — Single workflow (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/workflows/:id
 * PATCH  /api/v1/admin/orchestration/workflows/:id — merge fields; if
 *        `workflowDefinition` is provided, it is re-validated by the
 *        same Zod schema as create.
 * DELETE /api/v1/admin/orchestration/workflows/:id — soft delete.
 *
 * A read returns `definitionVersion`, the version of what the builder edits.
 * A PATCH that sends `draftDefinition` must send it back as `If-Match`
 * (428 without; 412 when the definition has moved on, §122 t-900).
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors';
import { validatePathParam, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import { requireIfMatch } from '@/lib/api/record-version';
import { workflowDefinitionVersion } from '@/lib/orchestration/config-versions';
import { discardDraft, saveDraft } from '@/lib/orchestration/workflows/version-service';
import { updateWorkflowSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import type { AiWorkflow, AiWorkflowVersion } from '@prisma/client';

/** The workflow with its published version, as the responses return it. */
function readWithVersion(id: string) {
  return prisma.aiWorkflow.findUniqueOrThrow({
    where: { id },
    include: { publishedVersion: true },
  });
}

/**
 * A workflow with the version of what the builder edits: a field, not the
 * ETag, as it covers only the definition (§122 t-900).
 */
function withDefinitionVersion<
  W extends AiWorkflow & { publishedVersion: AiWorkflowVersion | null },
>(workflow: W): W & { definitionVersion: string } {
  return { ...workflow, definitionVersion: workflowDefinitionVersion(workflow) };
}

export const GET = withAdminAuth<{ id: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const id = validatePathParam(rawId, cuidSchema, { label: 'workflow id' });

    const workflow = await prisma.aiWorkflow.findUnique({
      where: { id },
      include: { publishedVersion: true },
    });
    if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

    log.info('Workflow fetched', { workflowId: id });
    return successResponse(withDefinitionVersion(workflow));
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Workflows, their versions, schedules and templates are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);

export const PATCH = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const id = validatePathParam(rawId, cuidSchema, { label: 'workflow id' });

    const current = await prisma.aiWorkflow.findUnique({ where: { id } });
    if (!current) throw new NotFoundError(`Workflow ${id} not found`);

    const body = await validateRequestBody(request, updateWorkflowSchema);
    // A draft write carries the definition version the builder loaded, checked
    // under the row lock. Name, toggles and cost cap name nobody erasure
    // scrubs, so the list's toggle sends none.
    const loadedAt = body.draftDefinition !== undefined ? requireIfMatch(request) : [];

    // System workflows cannot be deactivated or have their template status changed
    if (current.isSystem) {
      if (body.isActive === false) {
        throw new ForbiddenError('System workflows cannot be deactivated');
      }
      if (body.isTemplate !== undefined) {
        throw new ForbiddenError('System workflows cannot have their template status changed');
      }
    }

    const data: Prisma.AiWorkflowUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.slug !== undefined) data.slug = body.slug;
    if (body.description !== undefined) data.description = body.description;
    if (body.patternsUsed !== undefined) data.patternsUsed = body.patternsUsed;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.isTemplate !== undefined) data.isTemplate = body.isTemplate;
    if (body.maxCostPerExecutionUsd !== undefined)
      data.maxCostPerExecutionUsd = body.maxCostPerExecutionUsd;
    if (body.metadata !== undefined) data.metadata = body.metadata;

    // A draft write takes the other fields with it, into the one update it
    // makes after the version check (§122 t-900): a stale save writes none of
    // them, and a slug conflict writes no draft. saveDraft and discardDraft
    // emit their own audit; `workflow.update` below covers the other fields.
    const fields = Object.keys(data).length > 0 ? data : undefined;
    let written: (AiWorkflow & { definitionVersion: string }) | null = null;
    let updated: Awaited<ReturnType<typeof readWithVersion>> | null = null;
    try {
      if (body.draftDefinition === null) {
        written = await discardDraft({
          workflowId: id,
          loadedAt,
          alongside: fields,
          userId: session.user.id,
          clientIp: clientIP,
        });
      } else if (body.draftDefinition !== undefined) {
        written = await saveDraft({
          workflowId: id,
          definition: body.draftDefinition,
          loadedAt,
          alongside: fields,
          userId: session.user.id,
          clientIp: clientIP,
        });
      } else if (fields) {
        updated = await prisma.aiWorkflow.update({
          where: { id },
          data: fields,
          include: { publishedVersion: true },
        });
      }
    } catch (err) {
      if (isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.workflowSlug)) {
        throw new ConflictError(`Workflow with slug '${body.slug}' already exists`);
      }
      throw err;
    }

    const after = updated ?? written;
    if (fields && after) {
      log.info('Workflow updated', {
        workflowId: id,
        adminId: session.user.id,
        fieldsChanged: Object.keys(fields),
      });
      logAdminAction({
        userId: session.user.id,
        action: 'workflow.update',
        entityType: 'workflow',
        entityId: id,
        entityName: after.name,
        // The draft is the draft audit's; only the other fields belong here.
        changes: computeChanges(current, after, {
          ignoreKeys: [
            'updatedAt',
            'createdAt',
            'publishedVersion',
            'draftDefinition',
            'definitionVersion',
          ],
        }),
        clientIp: clientIP,
      });
    }

    // The version a draft write returns was read in its own transaction: one
    // read after it commits could already carry another admin's save or an
    // erasure the builder's canvas has not seen, and its next save would then
    // pass the check.
    if (written) {
      return successResponse({
        ...(await readWithVersion(id)),
        definitionVersion: written.definitionVersion,
      });
    }
    return successResponse(withDefinitionVersion(updated ?? (await readWithVersion(id))));
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Workflows, their versions, schedules and templates are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);

export const DELETE = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const id = validatePathParam(rawId, cuidSchema, { label: 'workflow id' });

    const current = await prisma.aiWorkflow.findUnique({ where: { id } });
    if (!current) throw new NotFoundError(`Workflow ${id} not found`);

    if (current.isSystem) {
      throw new ForbiddenError('System workflows cannot be deleted');
    }

    await prisma.aiWorkflow.update({
      where: { id },
      data: { isActive: false },
    });

    log.info('Workflow soft-deleted', {
      workflowId: id,
      slug: current.slug,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'workflow.delete',
      entityType: 'workflow',
      entityId: id,
      entityName: current.name,
      clientIp: clientIP,
    });

    return successResponse({ id, isActive: false });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Workflows, their versions, schedules and templates are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);
