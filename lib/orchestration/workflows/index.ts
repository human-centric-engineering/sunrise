/**
 * Public surface of `lib/orchestration/workflows/`.
 *
 * Phase 3.2 ships only the structural DAG validator. The real
 * executor, step runners, and approval-resume helpers land with
 * Session 5.2 and will be re-exported from this barrel at that time.
 */

export { validateWorkflow } from '@/lib/orchestration/workflows/validator';
export type {
  WorkflowValidationResult,
  WorkflowValidationError,
} from '@/lib/orchestration/workflows/validator';

export { semanticValidateWorkflow } from '@/lib/orchestration/workflows/semantic-validator';
export type {
  SemanticValidationResult,
  SemanticValidationError,
  SemanticErrorCode,
} from '@/lib/orchestration/workflows/semantic-validator';

export { extractTemplateVariables } from '@/lib/orchestration/workflows/template-scanner';

export {
  saveDraft,
  discardDraft,
  publishDraft,
  rollback,
  createInitialVersion,
  listVersions,
  getVersion,
} from '@/lib/orchestration/workflows/version-service';
export type {
  SaveDraftArgs,
  DiscardDraftArgs,
  PublishDraftArgs,
  PublishDraftResult,
  RollbackArgs,
  RollbackResult,
  CreateInitialVersionArgs,
  ListVersionsOptions,
  ListVersionsResult,
} from '@/lib/orchestration/workflows/version-service';
