/**
 * Admin Orchestration — Save Workflow as Template
 *
 * POST /api/v1/admin/orchestration/workflows/:id/save-as-template
 *   - Clones the workflow definition into a new template.
 *   - Sets `templateSource: 'custom'`, `isTemplate: true`.
 *   - Strips execution history.
 *   - Accepts optional `name` and `description` overrides.
 *
 * Authentication: Admin role required.
 */

import { WRITER_TRANSACTION_OPTIONS } from '@/lib/privacy/erased-subjects';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { publishedSnapshotVersion } from '@/lib/orchestration/config-versions';
import { createInitialVersion } from '@/lib/orchestration/workflows/version-service';
import { findFreeWorkflowSlug } from '@/lib/orchestration/workflows/slug-availability';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';
import { assertWorkflowProvidersApproved } from '@/lib/orchestration/workflows/semantic-validator';

const saveAsTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(5000).optional(),
});

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success)
      throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
    const id = parsed.data;

    const workflow = await prisma.aiWorkflow.findUnique({
      where: { id },
      include: { publishedVersion: true },
    });
    if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);
    if (!workflow.publishedVersion) {
      throw new ValidationError(`Workflow ${id} has no published version to save as template`, {
        publishedVersionId: ['Publish a draft before saving as template'],
      });
    }
    // The published snapshot was Zod-valid when published; re-parse defensively
    // in case a manual DB edit / future schema change has invalidated it. A
    // ValidationError surfaces as a 400 rather than the 500 a raw ZodError throw
    // from `.parse()` would produce.
    const sourceDefinitionParsed = workflowDefinitionSchema.safeParse(
      workflow.publishedVersion.snapshot
    );
    if (!sourceDefinitionParsed.success) {
      throw new ValidationError(
        `Workflow ${id} has a malformed published definition — cannot save as template`,
        {
          publishedVersionId: sourceDefinitionParsed.error.issues.map(
            (i) => `${i.path.join('.')}: ${i.message}`
          ),
        }
      );
    }
    const sourceDefinition = sourceDefinitionParsed.data;

    const body = await validateRequestBody(request, saveAsTemplateSchema);

    // The template is a new, runnable workflow whose v1 is published here
    // without semantic validation — as create's is, so it is checked as create's
    // is (§120 t-743): every override's provider must be one the org is
    // approved for, whatever the source workflow was allowed to keep.
    await assertWorkflowProvidersApproved(sourceDefinition);

    // A slug no org holds: the column is unique across the install, and at
    // `multi` a plain read cannot see another org's workflows (t-728).
    const slug = await findFreeWorkflowSlug(`${workflow.slug}-template`);

    // Clone workflow + initial version atomically so the new template is
    // immediately runnable and has a clean version chain (no inherited history).
    let template;
    try {
      template = await prisma.$transaction(async (tx) => {
        const created = await tx.aiWorkflow.create({
          data: {
            name: body.name ?? `${workflow.name} (Template)`,
            slug,
            description: body.description ?? workflow.description,
            patternsUsed: workflow.patternsUsed,
            isActive: true,
            isTemplate: true,
            templateSource: 'custom',
            metadata: workflow.metadata as Prisma.InputJsonValue,
            createdBy: session.user.id,
          },
        });
        // The snapshot was read above, before the transaction: refused if an
        // erasure (or anything else) has moved the source since (§122 t-900).
        await createInitialVersion({
          tx,
          workflowId: created.id,
          definition: sourceDefinition,
          copiedFrom: {
            workflowId: workflow.id,
            definitionVersion: publishedSnapshotVersion(workflow),
          },
          userId: session.user.id,
        });
        return tx.aiWorkflow.findUniqueOrThrow({ where: { id: created.id } });
      }, WRITER_TRANSACTION_OPTIONS);
    } catch (err: unknown) {
      // P2002: unique constraint violation — another workflow took the slug
      // between findFreeWorkflowSlug's probe and this create.
      if (isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.workflowSlug)) {
        throw new ValidationError('Template slug already exists — please try again', {
          slug: ['A template with this slug was just created'],
        });
      }
      throw err;
    }

    log.info('Workflow saved as template', {
      sourceWorkflowId: id,
      templateId: template.id,
      templateSlug: slug,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'workflow.save_as_template',
      entityType: 'workflow',
      entityId: template.id,
      entityName: template.name,
      metadata: { sourceWorkflowId: id, templateSlug: slug },
      clientIp: clientIP,
    });

    return successResponse(template);
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
