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

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { createInitialVersion } from '@/lib/orchestration/workflows/version-service';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

const saveAsTemplateSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  description: z.string().min(1).max(5000).trim().optional(),
});

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

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
  const sourceDefinition = workflowDefinitionSchema.parse(workflow.publishedVersion.snapshot);

  const body = await validateRequestBody(request, saveAsTemplateSchema);

  // Generate a unique slug for the template
  const baseSlug = `${workflow.slug}-template`;
  let slug = baseSlug;
  let suffix = 1;
  while (await prisma.aiWorkflow.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${baseSlug}-${suffix++}`;
  }

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
      await createInitialVersion({
        tx,
        workflowId: created.id,
        definition: sourceDefinition,
        userId: session.user.id,
      });
      return tx.aiWorkflow.findUniqueOrThrow({ where: { id: created.id } });
    });
  } catch (err: unknown) {
    // P2002: unique constraint violation — slug race between findUnique and create
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
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
});
