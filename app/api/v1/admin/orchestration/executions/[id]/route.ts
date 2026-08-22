/**
 * Admin Orchestration — Get execution detail
 *
 * GET /api/v1/admin/orchestration/executions/:id
 *
 * Returns the `AiWorkflowExecution` row plus a parsed `trace` array, a
 * small projection suitable for the execution panel UI, and `costEntries`
 * — an unrolled view of the `AiCostLog` rows attributed to this run, used
 * by the trace viewer to break down per-step LLM cost.
 *
 * The `costEntries` array carries one row per LLM call. For multi-turn
 * executors (`tool_call`, `agent_call`, `orchestrator`) several entries
 * share a `stepId`; the UI groups them client-side. Entries with no
 * `metadata.stepId` are dropped — only step-attributed cost surfaces here
 * (chat/conversation cost has its own surfaces).
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
import { overlayStepDescriptions } from '@/lib/orchestration/trace/overlay-descriptions';
import {
  collectAgentSlugsFromSnapshot,
  overlayAgentInfo,
  type AgentMeta,
} from '@/lib/orchestration/trace/overlay-agents';

// `executionTraceSchema` is `z.array(...).catch([])` — parsing always succeeds,
// returning `[]` for malformed rows. Don't add a "trace corrupted" error path
// here: it would be unreachable and gives the wrong impression that this
// route guards against bad data with a 400.

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
    include: {
      workflow: { select: { id: true, name: true, slug: true } },
      // Load the pinned version's snapshot so we can overlay step
      // descriptions onto historical trace entries. Trace entries
      // emitted before the description field existed (or before the
      // seed backfilled the snapshots) have no `description` on
      // them; the overlay below fills it from the snapshot's step
      // definitions so the expanded accordion body always shows the
      // copy that's available today. The trace entry wins when it
      // already carries a description — that's the audit-honest
      // pinned-in-time value.
      version: { select: { snapshot: true } },
    },
  });
  if (!execution || !adminCanViewExecution(execution, session.user.id)) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  const parsedTrace = executionTraceSchema.parse(execution.executionTrace);
  // For each trace entry that lacks a `description`, fill it from the
  // pinned version's snapshot. Old executions ran before descriptions
  // were a thing — without this overlay their expanded rows would
  // show nothing. Entries that already carry a description keep it
  // (those are audit-honest pinned-in-time values).
  const snapshotForOverlays = execution.version?.snapshot ?? null;
  const traceWithDescriptions = overlayStepDescriptions({
    trace: parsedTrace,
    snapshot: snapshotForOverlays,
  });

  // Agent overlay: read agent_call slugs from the snapshot, batch-fetch
  // matching agents once, then attach `{ id, slug, name }` to every
  // `agent_call` trace entry. Resolved by SLUG against the current
  // AiAgent registry — so a renamed agent still resolves and the chip
  // shows the up-to-date display name. Trace viewer renders this as a
  // chip with a link to the agent edit page.
  const agentSlugs = collectAgentSlugsFromSnapshot(snapshotForOverlays);
  const agentsBySlug = new Map<string, AgentMeta>();
  if (agentSlugs.length > 0) {
    const agents = await prisma.aiAgent.findMany({
      where: { slug: { in: agentSlugs } },
      select: { id: true, slug: true, name: true },
    });
    for (const a of agents) {
      agentsBySlug.set(a.slug, { id: a.id, slug: a.slug, name: a.name });
    }
  }
  const trace = overlayAgentInfo({
    trace: traceWithDescriptions,
    snapshot: snapshotForOverlays,
    agentsBySlug,
  });

  // Pull every cost log attributed to this execution. Older rows in
  // production may have null metadata or no stepId — those are filtered
  // out below so we only surface step-attributed cost. Sorted ASC by
  // createdAt so multi-turn entries appear in the order the LLM saw them.
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

  // `currentRunningSteps` mirrors the shape returned by /executions/:id/live so
  // the page's initial paint can seed the live-poll hook directly. Empty for
  // terminal rows; one entry per in-flight step otherwise (a `parallel`
  // fan-out yields one entry per branch).
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
  const currentRunningSteps = TERMINAL_STATUSES.has(execution.status)
    ? []
    : (
        await prisma.aiWorkflowRunningStep.findMany({
          where: { executionId: id },
          orderBy: { startedAt: 'asc' },
          select: { stepId: true, label: true, stepType: true, startedAt: true, turns: true },
        })
      ).map((row) => ({
        stepId: row.stepId,
        label: row.label,
        stepType: row.stepType,
        startedAt: row.startedAt.toISOString(),
        // See live route for rationale — surfaces in-flight progress on
        // multi-turn steps so a slow agent_call doesn't look frozen.
        turnCount: Array.isArray(row.turns) ? row.turns.length : 0,
      }));

  return successResponse({
    execution: {
      id: execution.id,
      workflowId: execution.workflowId,
      // `versionId` and `parentExecutionId` feed the re-run dialog
      // (which needs to know which version this ran against and offer
      // versions added since) and the parent-lineage breadcrumb.
      versionId: execution.versionId,
      parentExecutionId: execution.parentExecutionId,
      status: execution.status,
      totalTokensUsed: execution.totalTokensUsed,
      totalCostUsd: execution.totalCostUsd,
      budgetLimitUsd: execution.budgetLimitUsd,
      currentStep: execution.currentStep,
      inputData: execution.inputData,
      outputData: execution.outputData,
      errorMessage: execution.errorMessage,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      createdAt: execution.createdAt,
      supervisorVerdict: execution.supervisorVerdict,
      supervisorScore: execution.supervisorScore,
      supervisorReport: execution.supervisorReport,
      supervisorReviewedAt: execution.supervisorReviewedAt,
      workflow: {
        id: execution.workflow.id,
        name: execution.workflow.name,
        slug: execution.workflow.slug,
      },
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
