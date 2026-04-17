/**
 * Re-export workflow template types from the canonical location.
 *
 * Template type definitions live in `@/types/orchestration` so both
 * seed data and UI code can reference them without circular dependencies.
 */
export type {
  WorkflowTemplate,
  WorkflowTemplatePattern,
  WorkflowTemplateUseCase,
} from '@/types/orchestration';
