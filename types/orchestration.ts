/**
 * Agent Orchestration Types
 *
 * TypeScript types for the Agent Orchestration Layer including
 * agent configuration, workflows, conversations, knowledge base,
 * evaluation, cost tracking, and provider configuration.
 */

import type {
  User,
  AiAgent,
  AiCapability,
  AiConversation,
  AiMessage,
  AiWorkflow,
  AiWorkflowExecution,
  AiKnowledgeDocument,
  AiKnowledgeChunk,
  AiEvaluationSession,
  AiEvaluationLog,
  AiCostLog,
  AiProviderConfig,
  AiProviderModel,
} from '@/types/prisma';

// ============================================================================
// Enums
// ============================================================================

/** LLM provider identifiers */
export const AgentProvider = {
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  OLLAMA: 'ollama',
  TOGETHER: 'together',
} as const;
export type AgentProvider = (typeof AgentProvider)[keyof typeof AgentProvider];

/** How a capability is executed */
export const ExecutionType = {
  INTERNAL: 'internal',
  API: 'api',
  WEBHOOK: 'webhook',
} as const;
export type ExecutionType = (typeof ExecutionType)[keyof typeof ExecutionType];

/** Workflow execution lifecycle states */
export const WorkflowStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED_FOR_APPROVAL: 'paused_for_approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

/** Chat message roles */
export const MessageRole = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool',
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

/** Evaluation session lifecycle states */
export const EvaluationStatus = {
  DRAFT: 'draft',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
} as const;
export type EvaluationStatus = (typeof EvaluationStatus)[keyof typeof EvaluationStatus];

/** Types of evaluation log events */
export const EventType = {
  USER_INPUT: 'user_input',
  AI_RESPONSE: 'ai_response',
  CAPABILITY_CALL: 'capability_call',
  CAPABILITY_RESULT: 'capability_result',
  ERROR: 'error',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** Cost log operation types */
export const CostOperation = {
  CHAT: 'chat',
  TOOL_CALL: 'tool_call',
  EMBEDDING: 'embedding',
  EVALUATION: 'evaluation',
} as const;
export type CostOperation = (typeof CostOperation)[keyof typeof CostOperation];

/** Knowledge document processing states */
export const DocumentStatus = {
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

/** LLM provider types */
export const ProviderType = {
  ANTHROPIC: 'anthropic',
  OPENAI_COMPATIBLE: 'openai-compatible',
} as const;
export type ProviderType = (typeof ProviderType)[keyof typeof ProviderType];

// ============================================================================
// Workflow Types
// ============================================================================

/**
 * Workflow step type identifier.
 *
 * This is an open string type — not a closed union — so new step types
 * can be added to the knowledge base and used in workflows without
 * modifying this file.
 *
 * Initial step types:
 * - "chain"           — sequential LLM calls
 * - "route"           — conditional branching
 * - "parallel"        — concurrent execution
 * - "reflect"         — self-critique loop
 * - "tool_call"       — capability invocation
 * - "plan"            — planning/decomposition
 * - "human_approval"  — pause for human review
 * - "rag_retrieve"    — knowledge base retrieval
 * - "llm_call"        — single LLM invocation
 *
 * Additional types (e.g. "orchestrator_worker", "blackboard", "debate")
 * can be registered via the knowledge base without code changes.
 */
export type WorkflowStepType = string;

/** Well-known step types for autocomplete and documentation */
export const KNOWN_STEP_TYPES = [
  'chain',
  'route',
  'parallel',
  'reflect',
  'tool_call',
  'plan',
  'human_approval',
  'rag_retrieve',
  'llm_call',
  'guard',
  'evaluate',
  'external_call',
  'agent_call',
  'send_notification',
  'orchestrator',
] as const;

/** A conditional edge connecting workflow steps */
export interface ConditionalEdge {
  /** ID of the target step */
  targetStepId: string;
  /** Optional condition expression; if omitted, edge is unconditional */
  condition?: string;
}

/** A single step in a workflow DAG */
export interface WorkflowStep {
  /** Unique step identifier within the workflow */
  id: string;
  /** Human-readable step name */
  name: string;
  /** Step type — see WorkflowStepType for known types */
  type: WorkflowStepType;
  /** Step-specific configuration */
  config: Record<string, unknown>;
  /** Outgoing edges to subsequent steps */
  nextSteps: ConditionalEdge[];
}

/** Complete workflow DAG definition stored in AiWorkflow.workflowDefinition */
export interface WorkflowDefinition {
  /** All steps in the workflow */
  steps: WorkflowStep[];
  /** ID of the first step to execute */
  entryStepId: string;
  /** How to handle step failures */
  errorStrategy: 'retry' | 'fallback' | 'skip' | 'fail';
}

// ============================================================================
// Workflow Execution Events (Session 5.2)
// ============================================================================

/**
 * Platform-agnostic workflow execution event.
 *
 * Returned by `OrchestrationEngine.execute()` as `AsyncIterable<ExecutionEvent>`.
 * The API layer converts these to SSE frames via `sseResponse`.
 *
 * Event ordering invariant (happy path):
 *   `workflow_started` → N × (`step_started` → `step_completed`) → `workflow_completed`
 *
 * On failure:
 *   `... → step_failed → workflow_failed`
 *
 * On pause:
 *   `... → step_started → approval_required` (stream ends here;
 *   execution row transitions to `paused_for_approval`).
 */
export type ExecutionEvent =
  | { type: 'workflow_started'; executionId: string; workflowId: string }
  | { type: 'step_started'; stepId: string; stepType: WorkflowStepType; label: string }
  | {
      type: 'step_completed';
      stepId: string;
      output: unknown;
      tokensUsed: number;
      costUsd: number;
      durationMs: number;
    }
  | { type: 'step_failed'; stepId: string; error: string; willRetry: boolean }
  | { type: 'approval_required'; stepId: string; payload: unknown }
  | { type: 'budget_warning'; usedUsd: number; limitUsd: number }
  | {
      type: 'workflow_completed';
      output: unknown;
      totalTokensUsed: number;
      totalCostUsd: number;
    }
  | { type: 'workflow_failed'; error: string; failedStepId?: string };

/**
 * One entry in the persisted `AiWorkflowExecution.executionTrace` JSON array.
 *
 * The engine writes one entry per completed step (or per terminally-failed
 * step). Survives process restarts and is the source of truth for the
 * execution detail view.
 */
export interface ExecutionTraceEntry {
  stepId: string;
  stepType: WorkflowStepType;
  label: string;
  status: 'completed' | 'failed' | 'skipped' | 'awaiting_approval';
  output: unknown;
  error?: string;
  tokensUsed: number;
  costUsd: number;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
}

/**
 * Per-step executor return value. Executors are pure functions w.r.t.
 * context — they return a `StepResult` and the engine merges it back
 * into the live `ExecutionContext`.
 */
export interface StepResult {
  /** Structured step output — written to `ctx.stepOutputs[stepId]`. */
  output: unknown;
  /** Token count consumed by this step (0 for non-LLM steps). */
  tokensUsed: number;
  /** Cost incurred by this step in USD (0 for non-LLM steps). */
  costUsd: number;
  /**
   * Explicit next step ids — overrides the step's declared `nextSteps`.
   * Used by `route` (branch selection) and `parallel` (fan-out control).
   * If omitted, the engine follows `step.nextSteps` as written.
   */
  nextStepIds?: string[];
  /**
   * If true, terminates the workflow with `workflow_completed` immediately
   * after this step. Used by the final step of a chain to signal completion.
   */
  terminal?: boolean;
}

/** Minimal summary of a workflow execution row, for list views. */
export interface WorkflowExecutionSummary {
  id: string;
  workflowId: string;
  status: WorkflowStatus;
  totalTokensUsed: number;
  totalCostUsd: number;
  startedAt: Date;
  completedAt: Date | null;
  currentStep: string | null;
}

/** Shape returned by the executions list API and consumed by the table component. */
export interface ExecutionListItem {
  id: string;
  workflowId: string;
  status: string;
  totalTokensUsed: number;
  totalCostUsd: number;
  startedAt: string | null;
  createdAt: string;
  completedAt: string | null;
  workflow: { id: string; name: string };
}

// ============================================================================
// Streaming Chat Events
// ============================================================================

/**
 * Platform-agnostic chat event type.
 *
 * Returned by the streaming chat handler as AsyncIterable<ChatEvent>.
 * The API layer converts these to SSE frames.
 */
export type ChatEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'content'; delta: string }
  | { type: 'status'; message: string }
  | { type: 'capability_result'; capabilitySlug: string; result: unknown }
  | {
      type: 'capability_results';
      results: Array<{ capabilitySlug: string; result: unknown }>;
    }
  | { type: 'warning'; code: string; message: string }
  | { type: 'content_reset'; reason: string }
  | { type: 'done'; tokenUsage: TokenUsage; costUsd: number; provider?: string; model?: string }
  | { type: 'error'; code: string; message: string };

/** Token usage breakdown */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ============================================================================
// System Instructions History
// ============================================================================

/** Entry in AiAgent.systemInstructionsHistory */
export interface SystemInstructionsHistoryEntry {
  instructions: string;
  changedAt: string;
  changedBy: string;
}

// ============================================================================
// Message Metadata
// ============================================================================

/**
 * Structured metadata stored in `AiMessage.metadata`.
 *
 * Shape varies by message role:
 * - `assistant` messages carry `tokenUsage`, `modelUsed`, `latencyMs`, `costUsd`
 * - `tool` messages carry `toolCall` and `result`
 *
 * All fields are optional and JSON-serializable so the object can be
 * written directly to a Prisma `Json` column without runtime conversion.
 */
export interface MessageMetadata {
  // Present on assistant messages
  tokenUsage?: TokenUsage;
  modelUsed?: string;
  latencyMs?: number;
  costUsd?: number;
  // Present on tool messages
  toolCall?: { id: string; name: string; arguments: unknown };
  result?: unknown;
  // Present on error-marker messages (persisted when streaming fails completely)
  error?: boolean;
  errorCode?: string;
}

// ============================================================================
// API Input/Output Types
// ============================================================================

/** Budget snapshot for an agent's month-to-date spend (list-view summary). */
export interface BudgetSummary {
  withinBudget: boolean;
  spent: number;
  limit: number | null;
  remaining: number | null;
  globalCapExceeded?: boolean;
}

/** Enriched agent row returned by the list endpoint. */
export type AiAgentListItem = AiAgent & {
  _count: { capabilities: number; conversations: number };
  _budget: BudgetSummary | null;
  creator?: { name: string | null };
};

/** Enriched workflow row returned by the list endpoint. */
export type AiWorkflowListItem = AiWorkflow & {
  _count: { executions: number };
};

/** Minimal agent projection nested in capability list items. */
export interface CapabilityAgentRef {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

/** Enriched capability row returned by the list endpoint. */
export type AiCapabilityListItem = AiCapability & {
  _agents: CapabilityAgentRef[];
};

/** Agent with its capabilities loaded */
export type AgentWithCapabilities = AiAgent & {
  capabilities: Array<{
    capability: AiCapability;
    isEnabled: boolean;
    customConfig: unknown;
    customRateLimit: number | null;
  }>;
};

/** Conversation with messages loaded */
export type ConversationWithMessages = AiConversation & {
  messages: AiMessage[];
  agent: Pick<AiAgent, 'id' | 'name' | 'slug'>;
};

/** Workflow with execution history */
export type WorkflowWithExecutions = AiWorkflow & {
  executions: AiWorkflowExecution[];
};

/** Knowledge document with chunk count */
export type DocumentWithChunks = AiKnowledgeDocument & {
  chunks: AiKnowledgeChunk[];
};

/** Evaluation session with logs */
export type EvaluationSessionWithLogs = AiEvaluationSession & {
  logs: AiEvaluationLog[];
  /** Null when the underlying agent has been deleted (relation is SetNull) */
  agent: Pick<AiAgent, 'id' | 'name' | 'slug'> | null;
};

/** Per-agent cost summary for a time period (distinct from the dashboard CostSummary in cost-reports.ts). */
export interface AgentCostSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  byOperation: Record<string, number>;
  entries: AiCostLog[];
}

// ============================================================================
// Orchestration Settings (Phase 4 Session 4.4)
// ============================================================================

/** Task categories that resolve to a default model via the settings singleton. */
export const TASK_TYPES = ['routing', 'chat', 'reasoning', 'embeddings'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Tunable weights for hybrid knowledge-base search. */
export interface SearchConfig {
  /** Cosine-distance reduction for keyword-matching chunks (non-positive, e.g. -0.02). */
  keywordBoostWeight: number;
  /** Multiplier applied to the vector similarity score (e.g. 1.0). */
  vectorWeight: number;
}

/** Action taken when an approval gate times out. */
export type ApprovalDefaultAction = 'deny' | 'allow';

/** Input guard behaviour for prompt injection detection. */
export type InputGuardMode = 'log_only' | 'warn_and_continue' | 'block';

/** Output guard behaviour for topic boundary enforcement. */
export type OutputGuardMode = 'log_only' | 'warn_and_continue' | 'block';

/** Escalation notification configuration stored in settings JSON column. */
export interface EscalationConfig {
  emailAddresses: string[];
  webhookUrl?: string;
  notifyOnPriority: 'all' | 'high' | 'medium_and_above';
}

/** Admin-editable defaults for the orchestration layer. */
export interface OrchestrationSettings {
  id: string;
  slug: 'global';
  /** Map of `TaskType` → canonical model id. */
  defaultModels: Record<TaskType, string>;
  /** Month-to-date global spend cap in USD, or `null` to disable. */
  globalMonthlyBudgetUsd: number | null;
  /** Tunable search weights, or `null` to use built-in defaults. */
  searchConfig: SearchConfig | null;
  /** Timestamp of the last successful knowledge-base seed. */
  lastSeededAt: Date | null;
  /** Default timeout (ms) for approval gates, or `null` to disable. */
  defaultApprovalTimeoutMs: number | null;
  /** Action when approval gate times out. */
  approvalDefaultAction: ApprovalDefaultAction | null;
  /** Input guard behaviour for prompt injection detection. */
  inputGuardMode: InputGuardMode;
  /** Output guard behaviour for topic boundary enforcement. */
  outputGuardMode: OutputGuardMode;
  /** Days to retain webhook delivery logs, or `null` for no auto-cleanup. */
  webhookRetentionDays: number | null;
  /** Days to retain cost logs, or `null` for no auto-cleanup. */
  costLogRetentionDays: number | null;
  /** Days to retain admin audit log rows, or `null` for no auto-cleanup. */
  auditLogRetentionDays: number | null;
  /** Max active conversations per user per agent, or `null` for unlimited. */
  maxConversationsPerUser: number | null;
  /** Max messages per conversation, or `null` for unlimited. */
  maxMessagesPerConversation: number | null;
  /** Escalation notification routing config, or `null` if not configured. */
  escalationConfig: EscalationConfig | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How `calculateLocalSavings()` derived its savings number. Only one mode
 * is currently reachable: local rows have local model ids, so there is no
 * direct hosted equivalent — every row prices against the cheapest
 * non-local model in the same tier. The union is kept as a single literal
 * so additional modes can be added here without changing the consumer shape.
 *
 *   - `tier_fallback` — every local row was priced against the cheapest
 *     non-local model in the same tier.
 */
export type SavingsMethodology = 'tier_fallback';

/** Result of `calculateLocalSavings({ dateFrom, dateTo })`. */
export interface LocalSavingsResult {
  usd: number;
  methodology: SavingsMethodology;
  /** Count of `AiCostLog` rows considered. */
  sampleSize: number;
  dateFrom: string;
  dateTo: string;
}

/** Provider config with creator info */
export type ProviderConfigWithCreator = AiProviderConfig & {
  creator: Pick<User, 'id' | 'name'>;
};

/** Knowledge search result */
export interface KnowledgeSearchResult {
  chunk: AiKnowledgeChunk;
  similarity: number;
  documentName?: string;
}

/** Knowledge graph node */
export interface GraphNode {
  id: string;
  name: string;
  type: 'kb' | 'document' | 'chunk';
  value: number;
  status?: string;
  category: number;
  metadata?: Record<string, unknown>;
}

/** Knowledge graph link */
export interface GraphLink {
  source: string;
  target: string;
  label?: string;
}

/** Knowledge graph category */
export interface GraphCategory {
  name: string;
}

/** Knowledge graph statistics */
export interface GraphStats {
  documentCount: number;
  completedCount: number;
  chunkCount: number;
  totalTokens: number;
}

/** Knowledge graph data (returned by graph endpoint) */
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  categories: GraphCategory[];
  stats: GraphStats;
}

/** Summary of a pattern for the pattern explorer card grid */
export interface PatternSummary {
  patternNumber: number;
  patternName: string;
  category: string | null;
  complexity: string | null;
  description: string | null;
  chunkCount: number;
}

// ============================================================================
// Workflow Template Types (seed data + UI)
// ============================================================================

/** A concrete business scenario a workflow template can solve. */
export interface WorkflowTemplateUseCase {
  /** Short title, e.g. "E-commerce returns processing". */
  title: string;
  /** 1-2 sentence description of the business problem. */
  scenario: string;
}

/** A single agentic pattern referenced by a template (for display). */
export interface WorkflowTemplatePattern {
  /** Pattern number from the agent-architect skill (1–21). */
  number: number;
  /** Human-readable name, e.g. "Routing", "Human-in-the-Loop". */
  name: string;
}

/**
 * Static description + DAG for a built-in workflow template.
 *
 * The `slug` doubles as the `AiWorkflow.slug` when the seeder upserts
 * this template into the database.
 */
export interface WorkflowTemplate {
  /** URL-safe unique identifier. Used as `AiWorkflow.slug` by the seeder. */
  slug: string;
  /** Friendly title shown in the dropdown + description dialog. */
  name: string;
  /** One-sentence summary used as `AiWorkflow.description` on seed. */
  shortDescription: string;
  /** Patterns referenced by this recipe — rendered as badges. */
  patterns: readonly WorkflowTemplatePattern[];
  /** Short prose describing the flow. */
  flowSummary: string;
  /** Concrete business scenarios this template addresses. */
  useCases: readonly WorkflowTemplateUseCase[];
  /** The full DAG loaded onto the canvas when the user picks this template. */
  workflowDefinition: WorkflowDefinition;
}

/**
 * Template-intrinsic metadata stored in `AiWorkflow.metadata` Json column.
 * Populated by the 004 seed unit and served to the UI via the workflows API.
 */
export interface WorkflowTemplateMetadata {
  flowSummary: string;
  useCases: readonly { title: string; scenario: string }[];
  patterns: readonly { number: number; name: string }[];
}

// ============================================================================
// Provider Selection Matrix
// ============================================================================

/** Provider tier roles for the selection matrix decision heuristic. */
export const TIER_ROLES = [
  'thinking',
  'worker',
  'infrastructure',
  'control_plane',
  'local_sovereign',
  'embedding',
] as const;
export type TierRole = (typeof TIER_ROLES)[number];

/** Rating levels used for reasoning depth, cost efficiency, and context length. */
export const RATING_LEVELS = ['very_high', 'high', 'medium', 'none'] as const;
export type RatingLevel = (typeof RATING_LEVELS)[number];

/** Context length levels. */
export const CONTEXT_LENGTH_LEVELS = ['very_high', 'high', 'medium', 'n_a'] as const;
export type ContextLengthLevel = (typeof CONTEXT_LENGTH_LEVELS)[number];

/** Latency rating levels. */
export const LATENCY_LEVELS = ['very_fast', 'fast', 'medium'] as const;
export type LatencyLevel = (typeof LATENCY_LEVELS)[number];

/** Tool-use capability levels. */
export const TOOL_USE_LEVELS = ['strong', 'moderate', 'none'] as const;
export type ToolUseLevel = (typeof TOOL_USE_LEVELS)[number];

/** Model capability types. */
export const MODEL_CAPABILITIES = ['chat', 'embedding'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** Embedding quality levels. */
export const EMBEDDING_QUALITY_LEVELS = ['high', 'medium', 'budget'] as const;
export type EmbeddingQuality = (typeof EMBEDDING_QUALITY_LEVELS)[number];

/** Task intents for the decision heuristic — maps to tier roles. */
export const TASK_INTENTS = [
  'thinking',
  'doing',
  'fast_looping',
  'high_reliability',
  'private',
  'embedding',
] as const;
export type TaskIntent = (typeof TASK_INTENTS)[number];

/** Human-readable tier metadata for display. */
export const TIER_ROLE_META: Record<TierRole, { label: string; description: string }> = {
  thinking: {
    label: 'Thinking',
    description: 'Expensive, sparse use — planning, decomposition, critical reasoning',
  },
  worker: {
    label: 'Worker',
    description: 'Cheap, parallel — tool execution, summarisation, transformations',
  },
  infrastructure: { label: 'Infrastructure', description: 'Scaling, latency-sensitive loops' },
  control_plane: {
    label: 'Control Plane',
    description: 'Fallback logic, A/B testing, cost routing, enterprise compliance',
  },
  local_sovereign: {
    label: 'Local / Sovereign',
    description: 'Privacy-sensitive workloads, offline capability',
  },
  embedding: {
    label: 'Embedding',
    description: 'Vector embedding models for semantic search and retrieval',
  },
};

// Re-export Prisma model types for convenience
export type {
  AiAgent,
  AiCapability,
  AiConversation,
  AiMessage,
  AiWorkflow,
  AiWorkflowExecution,
  AiKnowledgeDocument,
  AiKnowledgeChunk,
  AiEvaluationSession,
  AiEvaluationLog,
  AiCostLog,
  AiProviderConfig,
  AiProviderModel,
};
