/**
 * Admin Orchestration — Evaluation runs (list + create/queue).
 *
 * GET  /api/v1/admin/orchestration/evaluations/runs
 *   Paginated list of the caller's runs. Filters: status, subjectKind,
 *   datasetId, agentId.
 *
 * POST /api/v1/admin/orchestration/evaluations/runs
 *   Queue a new run. Validates: dataset ownership + content hash
 *   capture, subject validation (chat agent, or active workflow with a
 *   published version), every referenced grader exists, every
 *   reference-required grader is paired
 *   with a dataset that has expectedOutput on every case.
 *   The worker drains it on the next maintenance tick.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { datasetVisibilityWhere } from '@/lib/orchestration/access/dataset-access';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { createRunSchema, listRunsQuerySchema } from '@/lib/validations/orchestration-evaluations';
import { hasGrader, getGrader, listGraders } from '@/lib/orchestration/evaluations/graders';
import { noteMaintenanceWork } from '@/lib/orchestration/maintenance/idle-gate';
// Side-effect import — register every grader at module load so the
// preflight has a populated registry.
import '@/lib/orchestration/evaluations/graders';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, status, subjectKind, datasetId, agentId } = validateQueryParams(
    searchParams,
    listRunsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiEvaluationRunWhereInput = { userId: session.user.id };
  if (status) where.status = status;
  if (subjectKind) where.subjectKind = subjectKind;
  if (datasetId) where.datasetId = datasetId;
  if (agentId) where.agentId = agentId;

  const [runs, total] = await Promise.all([
    prisma.aiEvaluationRun.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      include: {
        agent: { select: { id: true, name: true, slug: true } },
        workflow: { select: { id: true, name: true, slug: true } },
        dataset: { select: { id: true, name: true, caseCount: true } },
      },
    }),
    prisma.aiEvaluationRun.count({ where }),
  ]);

  log.info('Listed runs', { count: runs.length, total });
  return paginatedResponse(runs, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createRunSchema);

  // 1. Grader existence + reference-requirement preflight ------------------
  const unknownGraders = body.metricConfigs.filter((m) => !hasGrader(m.slug));
  if (unknownGraders.length > 0) {
    throw new ValidationError(
      `Unknown grader slug(s): ${unknownGraders.map((m) => m.slug).join(', ')}`
    );
  }

  // Pairwise graders require two side-by-side outputs which a single
  // dataset-driven run can't supply. They're only invokable through the
  // experiment compare view's pairwise-judge action. Refuse them here so
  // operators don't queue a run that would silently skip them.
  const graderEntries = new Map(listGraders().map((g) => [g.slug, g]));
  const pairwiseInConfig = body.metricConfigs.filter(
    (m) => graderEntries.get(m.slug)?.family === 'pairwise'
  );
  if (pairwiseInConfig.length > 0) {
    throw new ValidationError(
      `Pairwise grader(s) [${pairwiseInConfig.map((m) => m.slug).join(', ')}] need two side-by-side outputs; trigger them from the experiment compare view, not a standalone run.`
    );
  }

  // 2. Dataset visibility + hash capture ------------------------------------
  // Theirs, or one nobody owns where the policy allows (t-679). An orphan the
  // caller can see but cannot run against is the incoherence #741 was about.
  const dataset = await prisma.aiDataset.findFirst({
    where: { AND: [await datasetVisibilityWhere(session), { id: body.datasetId }] },
    select: { id: true, contentHash: true, caseCount: true },
  });
  if (!dataset) throw new NotFoundError(`Dataset ${body.datasetId} not found`);

  // 3. Reference-required graders need expectedOutput on every case --------
  const referenceRequired = body.metricConfigs.filter((m) => getGrader(m.slug).referenceRequired);
  if (referenceRequired.length > 0) {
    const missing = await prisma.aiDatasetCase.count({
      where: { datasetId: dataset.id, expectedOutput: null },
    });
    if (missing > 0) {
      throw new ValidationError(
        `${missing} case(s) lack expectedOutput, required by grader(s): ${referenceRequired
          .map((m) => m.slug)
          .join(', ')}`
      );
    }
  }

  // 4. Subject ownership ---------------------------------------------------
  let subjectBrandVoice: string | undefined;
  if (body.subjectKind === 'agent') {
    const agent = await prisma.aiAgent.findUnique({
      where: { id: body.agentId! },
      select: { id: true, kind: true, brandVoiceInstructions: true },
    });
    if (!agent) throw new NotFoundError(`Agent ${body.agentId} not found`);
    if (agent.kind !== 'chat') {
      throw new ValidationError(
        `Subject agent must be a chat agent (got kind='${agent.kind}'). Pick an agent from /admin/orchestration/agents.`
      );
    }
    subjectBrandVoice = agent.brandVoiceInstructions ?? undefined;
  } else {
    // Workflow subject (Phase 3): the workflow must exist, be active, and
    // carry a published version. Workflows are globally addressable to
    // admins (see GET /workflows — no createdBy scope), so we don't add
    // one here either. The run row carries the caller's userId, so
    // case-result data flows back to the caller; the workflow itself is
    // shared tenant state.
    const workflow = await prisma.aiWorkflow.findUnique({
      where: { id: body.workflowId! },
      select: {
        id: true,
        isActive: true,
        publishedVersionId: true,
      },
    });
    if (!workflow) throw new NotFoundError(`Workflow ${body.workflowId} not found`);
    if (!workflow.isActive) {
      throw new ValidationError(
        `Workflow "${body.workflowId}" is inactive — activate it before running an evaluation.`
      );
    }
    if (!workflow.publishedVersionId) {
      throw new ValidationError(
        `Workflow "${body.workflowId}" has no published version. Publish a version before running an evaluation.`
      );
    }
    // No brand-voice for workflow subjects — the brand-voice judge only
    // applies to chat agents. Leaving `subjectBrandVoice` undefined makes
    // the brand-voice judge fall back to its default rubric.
  }

  // 5. Per-grader config validation + judge_agent slug existence ----------
  // For `judge_agent` entries: verify the named agent exists and is a
  // kind='judge' row. Also pin `subjectBrandVoice` into the config when
  // the brand-voice judge is selected — so dataset/run hash captures
  // the subject's voice as of submit time (mirrors datasetContentHash
  // pinning).
  const pinnedMetricConfigs = await Promise.all(
    body.metricConfigs.map(async (entry) => {
      const grader = getGrader(entry.slug);
      const parsed = grader.configSchema.safeParse(entry.config ?? grader.defaultConfig ?? {});
      if (!parsed.success) {
        throw new ValidationError(
          `Grader "${entry.slug}" config invalid: ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`
        );
      }
      if (entry.slug === 'workflow_as_judge') {
        const cfg = parsed.data as { workflowSlug: string };
        const judgeWorkflow = await prisma.aiWorkflow.findFirst({
          where: { slug: cfg.workflowSlug },
          select: { isActive: true, publishedVersionId: true },
        });
        if (!judgeWorkflow) {
          throw new ValidationError(`Judge workflow "${cfg.workflowSlug}" not found.`);
        }
        if (!judgeWorkflow.isActive) {
          throw new ValidationError(`Judge workflow "${cfg.workflowSlug}" is inactive.`);
        }
        if (!judgeWorkflow.publishedVersionId) {
          throw new ValidationError(
            `Judge workflow "${cfg.workflowSlug}" has no published version.`
          );
        }
        return entry;
      }

      if (entry.slug !== 'judge_agent') return entry;

      const cfg = parsed.data as { agentSlug: string; subjectBrandVoice?: string };
      const judgeAgent = await prisma.aiAgent.findUnique({
        where: { slug: cfg.agentSlug },
        select: { kind: true, isActive: true },
      });
      if (!judgeAgent) {
        throw new ValidationError(`Judge agent "${cfg.agentSlug}" not found.`);
      }
      if (judgeAgent.kind !== 'judge') {
        throw new ValidationError(
          `Agent "${cfg.agentSlug}" is not a judge (kind='${judgeAgent.kind}'). Pick from /admin/orchestration/judges.`
        );
      }
      if (!judgeAgent.isActive) {
        throw new ValidationError(`Judge agent "${cfg.agentSlug}" is inactive.`);
      }
      // Pin brand voice for the brand-voice judge — same hash-pin
      // discipline as datasetContentHash. Other judges ignore the
      // field.
      const isBrandVoiceJudge = cfg.agentSlug === 'eval-judge-brand-voice';
      const pinnedConfig: { agentSlug: string; subjectBrandVoice?: string } = {
        agentSlug: cfg.agentSlug,
      };
      if (isBrandVoiceJudge && subjectBrandVoice) {
        pinnedConfig.subjectBrandVoice = subjectBrandVoice;
      }
      return { slug: entry.slug, config: pinnedConfig };
    })
  );

  // 6. Queue the run -------------------------------------------------------
  const created = await prisma.aiEvaluationRun.create({
    data: {
      userId: session.user.id,
      name: body.name,
      description: body.description ?? null,
      subjectKind: body.subjectKind,
      agentId: body.agentId ?? null,
      workflowId: body.workflowId ?? null,
      datasetId: dataset.id,
      datasetContentHash: dataset.contentHash,
      metricConfigs: pinnedMetricConfigs as Prisma.InputJsonValue,
      judgeProvider: body.judgeProvider ?? null,
      judgeModel: body.judgeModel ?? null,
      subjectOutputSelector:
        body.subjectOutputSelector !== undefined
          ? (body.subjectOutputSelector as Prisma.InputJsonValue)
          : undefined,
      gateConfig:
        body.gateConfig !== undefined
          ? (body.gateConfig as unknown as Prisma.InputJsonValue)
          : undefined,
      status: 'queued',
      progress: { casesTotal: dataset.caseCount, casesDone: 0, casesFailed: 0 },
    },
  });

  // The run worker only advances on a maintenance tick, so an armed idle gate
  // would leave this queued for up to its cap (#442).
  noteMaintenanceWork('evaluation-run-queued');

  log.info('Run queued', { runId: created.id, datasetId: dataset.id });
  return successResponse(created, undefined, { status: 201 });
});
