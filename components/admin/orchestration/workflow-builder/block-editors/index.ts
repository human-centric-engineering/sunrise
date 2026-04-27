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

/** Minimal agent shape the orchestrator and agent-call editors need. */
export type AgentOption = { slug: string; name: string; description: string | null };

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

export { LlmCallEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/llm-call-editor';
export { ChainEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/chain-editor';
export { RouteEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/route-editor';
export { ParallelEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/parallel-editor';
export { ReflectEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/reflect-editor';
export { ToolCallEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/tool-call-editor';
export { PlanEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/plan-editor';
export { HumanApprovalEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/human-approval-editor';
export { RagRetrieveEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/rag-retrieve-editor';
export { GuardEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/guard-editor';
export { EvaluateEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/evaluate-editor';
export { ExternalCallEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/external-call-editor';
export { AgentCallEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/agent-call-editor';
export { NotificationEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/notification-editor';
export { OrchestratorEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/orchestrator-editor';
