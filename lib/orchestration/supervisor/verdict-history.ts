/**
 * A run's supervisor verdict history (t-925, t-951).
 *
 * Two writers replace a run's verdict: the retroactive review route and the
 * in-workflow `supervisor` step (through the engine's context patch). Both
 * archive the verdict they replace into `supervisorReport.previousVerdicts[]`
 * by this one rule — operators rerun for a reason, and overwriting silently
 * would discard the history they want to compare against. Each reads the
 * stored verdict under the run's row lock, at write time, so a writer that
 * landed in between is archived rather than dropped.
 */

import type { AiWorkflowExecution } from '@prisma/client';

import { logger } from '@/lib/logging';
import { priorSupervisorReportSchema } from '@/lib/validations/orchestration';
import type { SupervisorPreviousVerdict } from '@/types/orchestration';

/** The columns the archive is built from. */
export type StoredVerdict = Pick<
  AiWorkflowExecution,
  'supervisorVerdict' | 'supervisorReport' | 'supervisorReviewedAt'
>;

/** Select these, under the run's row lock, to pass to {@link withPriorArchived}. */
export const STORED_VERDICT_SELECT = {
  supervisorVerdict: true,
  supervisorReport: true,
  supervisorReviewedAt: true,
} as const;

/**
 * The new report with the run's stored verdict archived into
 * `previousVerdicts[]`, after the history the stored report already carries.
 * The prior column shape is validated so a corrupted Json row can't break the
 * archive lift; on parse failure the archive is logged and skipped rather than
 * failing the write (the new verdict still writes through cleanly).
 */
export function withPriorArchived<R extends object>(
  report: R,
  stored: StoredVerdict,
  executionId: string
): R & { previousVerdicts?: SupervisorPreviousVerdict[] } {
  const finalReport: R & { previousVerdicts?: SupervisorPreviousVerdict[] } = { ...report };
  if (!stored.supervisorVerdict || !stored.supervisorReport) return finalReport;
  const priorParsed = priorSupervisorReportSchema.safeParse(stored.supervisorReport);
  if (!priorParsed.success) {
    logger.warn('Prior supervisorReport failed schema validation — archive skipped', {
      executionId,
      issues: priorParsed.error.issues.map((i) => i.message),
    });
    return finalReport;
  }
  const prior = priorParsed.data;
  const priorEntry: SupervisorPreviousVerdict = {
    verdict: prior.verdict,
    score: typeof prior.score === 'number' ? prior.score : null,
    reviewedAt: stored.supervisorReviewedAt?.toISOString() ?? new Date(0).toISOString(),
    triggeredBy: prior.triggeredBy ?? 'in_workflow',
  };
  finalReport.previousVerdicts = [...(prior.previousVerdicts ?? []), priorEntry];
  return finalReport;
}
