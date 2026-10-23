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
import { WRITER_TRANSACTION_OPTIONS } from '@/lib/privacy/erased-subjects';
import {
  assertUnchangedSince,
  workflowDefinitionVersion,
} from '@/lib/orchestration/config-versions';
import { saveDraft } from '@/lib/orchestration/workflows/version-service';
import { updateWorkflowSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import type { AiWorkflow, AiWorkflowVersion } from '@prisma/client';

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

    // Definition edits go to `draftDefinition` only — published versions are
    // promoted via POST /publish. The `saveDraft` service emits its own audit
    // entry; the `workflow.update` audit below covers other field changes.
    let baseline = current;
    if (body.draftDefinition !== undefined) {
      if (body.draftDefinition === null) {
        await prisma.$transaction(async (tx) => {
          await assertUnchangedSince(tx, { kind: 'workflow-definition', id }, loadedAt);
          await tx.aiWorkflow.update({
            where: { id },
            data: { draftDefinition: Prisma.DbNull },
          });
        }, WRITER_TRANSACTION_OPTIONS);
      } else {
        await saveDraft({
          workflowId: id,
          definition: body.draftDefinition,
          loadedAt,
          userId: session.user.id,
          clientIp: clientIP,
        });
      }
      // Re-read after the draft write so the workflow.update audit's
      // computeChanges doesn't double-log draftDefinition (saveDraft already
      // logged it via workflow.draft.save).
      baseline = (await prisma.aiWorkflow.findUnique({ where: { id } })) ?? current;
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

    // Skip the workflow.update path entirely when only `draftDefinition` was
    // sent — saveDraft / discardDraft has already emitted its own audit, and
    // running an empty Prisma update + a redundant `workflow.update` audit
    // double-logs the same change.
    if (Object.keys(data).length === 0) {
      const workflow = await prisma.aiWorkflow.findUniqueOrThrow({
        where: { id },
        include: { publishedVersion: true },
      });
      return successResponse(withDefinitionVersion(workflow));
    }

    try {
      const workflow = await prisma.aiWorkflow.update({
        where: { id },
        data,
        include: { publishedVersion: true },
      });
      log.info('Workflow updated', {
        workflowId: id,
        adminId: session.user.id,
        fieldsChanged: Object.keys(data),
      });

      logAdminAction({
        userId: session.user.id,
        action: 'workflow.update',
        entityType: 'workflow',
        entityId: id,
        entityName: workflow.name,
        changes: computeChanges(baseline, workflow, {
          ignoreKeys: ['updatedAt', 'createdAt', 'publishedVersion'],
        }),
        clientIp: clientIP,
      });

      return successResponse(withDefinitionVersion(workflow));
    } catch (err) {
      if (isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.workflowSlug)) {
        throw new ConflictError(`Workflow with slug '${body.slug}' already exists`);
      }
      throw err;
    }
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
