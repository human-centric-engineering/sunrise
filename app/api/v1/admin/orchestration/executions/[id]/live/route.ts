/**
 * Admin Orchestration — Get execution live snapshot
 *
 * GET /api/v1/admin/orchestration/executions/:id/live
 *
 * Designed for high-frequency (~1s) polling from the execution detail page.
 * Returns everything the live view needs in one round-trip:
 *
 *   - `snapshot`             — the same narrow fields as `/status` (status,
 *                              currentStep, errorMessage, tokens, cost, dates).
 *   - `trace`                — persisted step trace (steps that have terminated).
 *   - `costEntries`          — per-LLM-call cost rows attributed to this run.
 *   - `currentRunningSteps`  — array of `{ stepId, label, stepType, startedAt,
 *                              completedAt }` for every step currently in
 *                              flight. During a `parallel` step's fan-out this
 *                              carries one entry per branch; empty array on
 *                              terminal rows. `completedAt` is set on a branch
 *                              that finished while siblings are still running
 *                              (Phase 2 of the parallel-bar work) so the
 *                              timeline can render a greyed wait segment.
 *
 * `currentRunningSteps` is read from `AiWorkflowRunningStep` (side table; one
 * row per in-flight step) so the detail view can render every branch
 * simultaneously instead of just the most-recently-entered one.
 *
 * Ownership: the caller's own runs, plus system-owned runs (`userId = null`
 * — schedule- and inbound-triggered). Another admin's own run returns 404
 * (not 403) — we never confirm existence of a row the caller cannot see.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { cuidSchema } from '@/lib/validations/common';
import { adminCanViewExecution } from '@/lib/orchestration/access/execution-access';
import { executionTraceSchema } from '@/lib/validations/orchestration';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

interface CostEntry {
  stepId: string;
  /**
   * The capability that produced this row, when it is a `tool_call`. The
   * dispatcher writes `model: 'n/a'`, `provider: 'capability'` and 0/0/$0, so
   * without the slug an `agent_call` step that invoked five tools renders five
   * identical, information-free rows. Absent for LLM rows, which identify
   * themselves by model (#600).
   */
  slug?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  operation: string;
  createdAt: string;
}

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      status: true,
      currentStep: true,
      errorMessage: true,
      totalTokensUsed: true,
      totalCostUsd: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      executionTrace: true,
    },
  });
  if (!execution || !adminCanViewExecution(execution, session.user.id)) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  const trace = executionTraceSchema.parse(execution.executionTrace);

  const costLogs = await prisma.aiCostLog.findMany({
    where: { workflowExecutionId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      model: true,
      provider: true,
      inputTokens: true,
      outputTokens: true,
      totalCostUsd: true,
      operation: true,
      metadata: true,
      createdAt: true,
    },
  });

  const costEntries: CostEntry[] = [];
  for (const row of costLogs) {
    const stepId = extractStepId(row.metadata);
    if (!stepId) continue;
    const slug = extractSlug(row.metadata);
    costEntries.push({
      stepId,
      ...(slug ? { slug } : {}),
      model: row.model,
      provider: row.provider,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalCostUsd: row.totalCostUsd,
      operation: row.operation,
      createdAt: row.createdAt.toISOString(),
    });
  }

  // Surface every in-flight step on terminal-status-aware reads. During
  // a `parallel` fan-out each branch lands as its own row, so the array
  // can carry N entries — the detail view synthesises one "running"
  // trace row per entry. Empty array on terminal rows.
  const isTerminal = TERMINAL_STATUSES.has(execution.status);
  const currentRunningSteps = isTerminal
    ? []
    : (
        await prisma.aiWorkflowRunningStep.findMany({
          where: { executionId: id },
          orderBy: { startedAt: 'asc' },
          select: {
            stepId: true,
            label: true,
            stepType: true,
            startedAt: true,
            completedAt: true,
            turns: true,
          },
        })
      ).map((row) => ({
        stepId: row.stepId,
        label: row.label,
        stepType: row.stepType,
        startedAt: row.startedAt.toISOString(),
        // Set on a parallel branch that finished before its siblings.
        // The detail view uses it to render a coloured processing
        // portion plus a greyed wait portion on that branch's bar
        // until the slowest sibling settles and the row is deleted.
        // Null on still-running branches and on sequential steps.
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        // Progress indicator for multi-turn steps (`agent_call`,
        // `orchestrator`, `reflect`). Each `recordTurn` call adds an
        // entry, so on a long-running agent_call this ticks up as the
        // model fires more tool iterations — lets the operator see
        // forward progress instead of staring at a frozen "Running"
        // badge. Always 0 for single-shot step types.
        turnCount: Array.isArray(row.turns) ? row.turns.length : 0,
      }));

  return successResponse({
    snapshot: {
      id: execution.id,
      status: execution.status,
      currentStep: execution.currentStep,
      errorMessage: execution.errorMessage,
      totalTokensUsed: execution.totalTokensUsed,
      totalCostUsd: execution.totalCostUsd,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      createdAt: execution.createdAt,
    },
    trace,
    costEntries,
    currentRunningSteps,
  });
});

function extractSlug(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const value = (metadata as { slug?: unknown }).slug;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractStepId(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const value = (metadata as { stepId?: unknown }).stepId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
