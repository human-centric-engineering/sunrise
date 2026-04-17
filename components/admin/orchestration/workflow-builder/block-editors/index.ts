/**
 * Per-step-type config editors rendered inside `BlockConfigPanel`.
 *
 * Each editor is a small controlled component that takes the current step
 * config, a reference list of capabilities (only used by `tool-call`), and
 * an `onChange(partial)` callback that the panel merges into the node's
 * `data.config`. No editor owns its own state — the canvas is the single
 * source of truth and round-trips through the store.
 */

import type { AiCapability } from '@/types/orchestration';

/** Minimal capability shape the tool-call editor needs. */
export type CapabilityOption = Pick<AiCapability, 'id' | 'slug' | 'name' | 'description'>;

/**
 * Shared props contract for every editor. Extended per step type with a
 * specific `config` shape via intersection.
 */
export interface EditorProps<TConfig extends Record<string, unknown>> {
  /** Current step config — partial merges land back via `onChange`. */
  config: TConfig;
  /** Merge a subset of config keys into the step's config. */
  onChange: (partial: Partial<TConfig>) => void;
  /** Only the tool-call editor reads this; other editors ignore it. */
  capabilities?: readonly CapabilityOption[];
}

export { LlmCallEditor } from './llm-call-editor';
export { ChainEditor } from './chain-editor';
export { RouteEditor } from './route-editor';
export { ParallelEditor } from './parallel-editor';
export { ReflectEditor } from './reflect-editor';
export { ToolCallEditor } from './tool-call-editor';
export { PlanEditor } from './plan-editor';
export { HumanApprovalEditor } from './human-approval-editor';
export { RagRetrieveEditor } from './rag-retrieve-editor';
export { GuardEditor } from './guard-editor';
export { EvaluateEditor } from './evaluate-editor';
export { ExternalCallEditor } from './external-call-editor';
