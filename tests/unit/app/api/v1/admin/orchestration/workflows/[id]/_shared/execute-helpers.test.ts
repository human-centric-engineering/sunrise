/**
 * Unit Tests: prepareWorkflowExecution (execute-helpers)
 *
 * Tests the shared pre-flight validation helper used by both the execute
 * and execute-stream workflow API routes.
 *
 * Test Coverage:
 * - Happy path: returns { workflow, definition } for a valid active workflow
 * - ID validation: throws ValidationError for a non-CUID rawId
 * - Workflow lookup: throws NotFoundError when prisma returns null
 * - Active check: throws ValidationError when workflow.isActive is false
 * - Definition parse: throws ValidationError when workflowDefinition fails Zod
 * - Structural validation: throws ValidationError when validateWorkflow returns errors
 * - Semantic validation: throws ValidationError when semanticValidateWorkflow returns errors
 *
 * Real schemas used (NOT mocked):
 * - @/lib/validations/orchestration (workflowDefinitionSchema)
 * - @/lib/validations/common (cuidSchema)
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Module mocks (must appear before subject import) ────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/workflows', () => ({
  validateWorkflow: vi.fn(() => ({ ok: true, errors: [] })),
  semanticValidateWorkflow: vi.fn(() => Promise.resolve({ ok: true, errors: [] })),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { validateWorkflow, semanticValidateWorkflow } from '@/lib/orchestration/workflows';
import { ValidationError, NotFoundError } from '@/lib/api/errors';
import { prepareWorkflowExecution } from '@/app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Valid CUID v2 — 25 chars, starts with 'c' */
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwul';

/**
 * A minimal workflow definition that satisfies workflowDefinitionSchema.
 * Uses the same fixture as the execute/route tests so both test files stay in
 * sync if the schema changes.
 */
const VALID_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'LLM Step',
      type: 'llm_call',
      config: { model: 'gpt-4o-mini', prompt: 'Hello' },
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail',
};

/**
 * Build a realistic workflow DB row with optional per-test overrides.
 * All fields that a real `prisma.aiWorkflow.findUnique` would return are
 * present so we can assert structural side-effects without type coercion hacks.
 */
function makeWorkflow(overrides: Record<string, unknown> = {}) {
  // Compatibility shim: `workflowDefinition` overrides translate to a
  // synthetic published-version snapshot — that's where prepareWorkflowExecution
  // now reads the definition from.
  const { workflowDefinition: snapshotOverride, ...rest } = overrides;
  const snapshot = snapshotOverride === undefined ? VALID_DEFINITION : snapshotOverride;
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    isActive: true,
    isTemplate: false,
    draftDefinition: null,
    publishedVersionId: snapshot === null ? null : 'wfv-1',
    publishedVersion: snapshot === null ? null : { id: 'wfv-1', version: 1, snapshot },
    patternsUsed: [],
    templateSource: null,
    metadata: {},
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...rest,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('prepareWorkflowExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore safe defaults so each test starts from a passing state.
    vi.mocked(validateWorkflow).mockReturnValue({ ok: true, errors: [] });
    vi.mocked(semanticValidateWorkflow).mockResolvedValue({ ok: true, errors: [] });
  });

  describe('happy path', () => {
    it('should return { workflow, definition } for a valid active workflow', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      // Act
      const result = await prepareWorkflowExecution(WORKFLOW_ID);

      // Assert — the helper wraps the DB row into { workflow: { id }, definition }
      expect(result.workflow).toEqual({ id: WORKFLOW_ID });
      expect(result.definition).toMatchObject({
        steps: expect.arrayContaining([expect.objectContaining({ id: 'step-1' })]),
        entryStepId: 'step-1',
        errorStrategy: 'fail',
      });
    });

    it('should query the database with the parsed CUID', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      // Act
      await prepareWorkflowExecution(WORKFLOW_ID);

      // Assert — the helper calls prisma with the exact validated id and
      // joins the published version so the snapshot is available.
      expect(prisma.aiWorkflow.findUnique).toHaveBeenCalledWith({
        where: { id: WORKFLOW_ID },
        include: { publishedVersion: true },
      });
    });

    it('should run both structural and semantic validators before returning', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);

      // Act
      await prepareWorkflowExecution(WORKFLOW_ID);

      // Assert — both validators are invoked (each receives the parsed definition)
      expect(validateWorkflow).toHaveBeenCalledOnce();
      expect(semanticValidateWorkflow).toHaveBeenCalledOnce();
    });
  });

  describe('ID validation', () => {
    it('should throw ValidationError for a plaintext non-CUID string', async () => {
      // Arrange — real cuidSchema will reject this
      const rawId = 'not-a-valid-cuid';

      // Act & Assert
      await expect(prepareWorkflowExecution(rawId)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for an empty string', async () => {
      await expect(prepareWorkflowExecution('')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for a UUID (wrong format)', async () => {
      // UUID passes basic length checks but fails CUID format
      await expect(
        prepareWorkflowExecution('550e8400-e29b-41d4-a716-446655440000')
      ).rejects.toThrow(ValidationError);
    });

    it('should not query the database when the ID format is invalid', async () => {
      // Arrange
      const rawId = 'not-a-valid-cuid';

      // Act — ignore the thrown error
      await prepareWorkflowExecution(rawId).catch(() => undefined);

      // Assert — no DB round-trip should have happened
      expect(prisma.aiWorkflow.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('workflow lookup', () => {
    it('should throw NotFoundError when the workflow does not exist in the database', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      // Act & Assert
      await expect(prepareWorkflowExecution(WORKFLOW_ID)).rejects.toThrow(NotFoundError);
    });

    it('should include the workflow id in the NotFoundError message', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      // Act & Assert
      await expect(prepareWorkflowExecution(WORKFLOW_ID)).rejects.toThrow(WORKFLOW_ID);
    });
  });

  describe('active check', () => {
    it('should throw ValidationError when workflow.isActive is false', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ isActive: false }) as never
      );

      // Act & Assert
      await expect(prepareWorkflowExecution(WORKFLOW_ID)).rejects.toThrow(ValidationError);
    });

    it('should not run definition parsing when the workflow is inactive', async () => {
      // Arrange — an inactive workflow with a valid definition; we want early exit
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ isActive: false }) as never
      );

      // Act
      await prepareWorkflowExecution(WORKFLOW_ID).catch(() => undefined);

      // Assert — neither validator should be reached
      expect(validateWorkflow).not.toHaveBeenCalled();
      expect(semanticValidateWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('workflow definition parse', () => {
    it('should throw ValidationError when workflowDefinition fails the Zod schema', async () => {
      // Arrange — definition does not satisfy workflowDefinitionSchema
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinition: { invalid: true } }) as never
      );

      // Act & Assert
      await expect(prepareWorkflowExecution(WORKFLOW_ID)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when workflowDefinition is null', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinition: null }) as never
      );

      // Act & Assert
      await expect(prepareWorkflowExecution(WORKFLOW_ID)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when steps array is empty', async () => {
      // Arrange — schema requires at least one step
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({
          workflowDefinition: { steps: [], entryStepId: 'x', errorStrategy: 'fail' },
        }) as never
      );

      // Act & Assert
      await expect(prepareWorkflowExecution(WORKFLOW_ID)).rejects.toThrow(ValidationError);
    });

    it('should not run DAG or semantic validation when definition parsing fails', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflow({ workflowDefinition: { bad: 'data' } }) as never
      );

      // Act
      await prepareWorkflowExecution(WORKFLOW_ID).catch(() => undefined);

      // Assert — validators should not be called if the definition is malformed
      expect(validateWorkflow).not.toHaveBeenCalled();
      expect(semanticValidateWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('structural validation (validateWorkflow)', () => {
    it('should throw ValidationError when validateWorkflow returns ok:false', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(validateWorkflow).mockReturnValue({
        ok: false,
        errors: [{ code: 'CYCLE_DETECTED', message: 'Cycle detected in workflow graph' }],
      });

      // Act & Assert
      await expect(prepareWorkflowExecution(WORKFLOW_ID)).rejects.toThrow(ValidationError);
    });

    it('should not run semantic validation when structural validation fails', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(validateWorkflow).mockReturnValue({
        ok: false,
        errors: [{ code: 'UNREACHABLE_STEP', message: 'Step step-2 is unreachable' }],
      });

      // Act
      await prepareWorkflowExecution(WORKFLOW_ID).catch(() => undefined);

      // Assert — semantic validator must not run if structural check fails first
      expect(semanticValidateWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('semantic validation (semanticValidateWorkflow)', () => {
    it('should throw ValidationError when semanticValidateWorkflow returns ok:false', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(semanticValidateWorkflow).mockResolvedValue({
        ok: false,
        errors: [
          {
            code: 'INACTIVE_AGENT',
            message: 'Agent agent-disabled is not active',
            stepId: 'step-1',
          },
        ],
      });

      // Act & Assert
      await expect(prepareWorkflowExecution(WORKFLOW_ID)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when a referenced capability is inactive', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflow() as never);
      vi.mocked(semanticValidateWorkflow).mockResolvedValue({
        ok: false,
        errors: [
          {
            code: 'INACTIVE_CAPABILITY',
            message: 'Capability cap-disabled is not active',
            stepId: 'step-1',
          },
        ],
      });

      // Act & Assert
      await expect(prepareWorkflowExecution(WORKFLOW_ID)).rejects.toThrow(ValidationError);
    });
  });
});
