/**
 * Shared helpers for workflow execution routes.
 *
 * Extracts the common pre-flight validation logic used by both:
 * - POST /api/v1/admin/orchestration/workflows/:id/execute
 * - GET  /api/v1/admin/orchestration/workflows/:id/execute-stream
 *
 * Validates the workflow ID, looks up the workflow, checks `isActive`,
 * parses the definition, and runs structural + semantic validation.
 */

import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateWorkflow, semanticValidateWorkflow } from '@/lib/orchestration/workflows';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import type { WorkflowDefinition } from '@/types/orchestration';

interface PrepareResult {
  workflow: { id: string };
  definition: WorkflowDefinition;
}

/**
 * Validate and load a workflow for execution.
 *
 * 1. Parse `rawId` as a CUID
 * 2. Look up the workflow from the database
 * 3. Assert `isActive`
 * 4. Parse `workflowDefinition` with `workflowDefinitionSchema`
 * 5. Run structural (`validateWorkflow`) and semantic validation
 *
 * @throws {ValidationError} if the ID format, active check, or definition validation fails
 * @throws {NotFoundError} if the workflow does not exist
 */
export async function prepareWorkflowExecution(rawId: string): Promise<PrepareResult> {
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const workflow = await prisma.aiWorkflow.findUnique({ where: { id } });
  if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

  if (!workflow.isActive) {
    throw new ValidationError(`Workflow ${id} is not active`, {
      isActive: ['Workflow must be active before it can be executed'],
    });
  }

  const defParsed = workflowDefinitionSchema.safeParse(workflow.workflowDefinition);
  if (!defParsed.success) {
    throw new ValidationError(`Workflow ${id} has a malformed definition`, {
      workflowDefinition: defParsed.error.issues.map((i) => i.message),
    });
  }
  const definition = defParsed.data;

  const dag = validateWorkflow(definition);
  if (!dag.ok) {
    throw new ValidationError(`Workflow ${id} has a structurally invalid definition`, {
      workflowDefinition: dag.errors,
    });
  }

  const semantic = await semanticValidateWorkflow(definition);
  if (!semantic.ok) {
    throw new ValidationError(`Workflow ${id} references invalid agents or capabilities`, {
      workflowDefinition: semantic.errors,
    });
  }

  return { workflow: { id: workflow.id }, definition };
}
