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
  AiWorkflowVersion,
  AiKnowledgeDocument,
  AiKnowledgeChunk,
  AiEvaluationSession,
  AiEvaluationLog,
  AiCostLog,
  AiProviderConfig,
  AiProviderModel,
} from '@/types/prisma';
import type { ProvenanceItem } from '@/lib/orchestration/provenance/types';

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
  TRANSCRIPTION: 'transcription',
  /**
   * Image / PDF attachment processing. Priced flat per attachment for
   * v1 — actual provider billing rolls up under the chat-completion
   * row; this operation tracks attachment-specific overhead the
   * platform charges for serving the modality.
   */
  VISION: 'vision',
  /**
   * Post-upload BM25 keyword enrichment on a knowledge document — runs
   * a chat completion per chunk to generate 3–8 keyword phrases. Split
   * from the regular `chat` operation so the Costs admin can show how
   * much operators have spent on this opt-in enrichment.
   */
  KNOWLEDGE_ENRICH_KEYWORDS: 'knowledge.enrich_keywords',
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
  /**
   * Maximum number of times this edge may loop back to an already-visited
   * step. Only meaningful on back-edges (edges that point to an ancestor
   * in the DAG). Requires a `condition` so the loop only triggers on
   * specific outcomes. The DAG validator permits cycles on edges that
   * carry this property; the engine tracks iteration count at runtime.
   */
  maxRetries?: number;
  /**
   * Authoring-only: absolute (x, y) of a quadratic-bezier control point
   * in flow coordinates. Lets the canvas bow an edge around intervening
   * nodes — important for retry back-edges that would otherwise cut
   * through the forward steps. Persisted on save and re-applied on
   * load. The engine ignores this field.
   */
  _layout?: {
    controlPointX: number;
    controlPointY: number;
  };
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

/** Complete workflow DAG definition stored in AiWorkflowVersion.snapshot */
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
  | {
      type: 'step_retry';
      fromStepId: string;
      targetStepId: string;
      attempt: number;
      maxRetries: number;
      reason: string;
      // True when the retry budget is exhausted and `targetStepId`
      // points to a sibling fallback edge instead of the retry target.
      exhausted?: boolean;
    }
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
 *
 * The trailing optional fields (`input`, `model`, `provider`, `inputTokens`,
 * `outputTokens`, `llmDurationMs`) were added in the trace-viewer / latency
 * attribution work (item 10 of `improvement-priorities.md`). They are all
 * optional so historical rows continue to parse cleanly — `executionTraceSchema`
 * is back-compatible.
 */
/**
 * One turn within a multi-turn step (`agent_call`, `orchestrator`, `reflect`).
 *
 * Persisted mid-flight to `AiWorkflowExecution.currentStepTurns` so a crashed
 * run resumes from the next turn rather than restarting the whole step. On
 * step termination the engine moves the array into the trace entry's `turns`
 * field; from then on the entries are read-only history.
 *
 * Discriminated by `kind` so each step type carries the state shape its
 * executor needs to resume:
 *  - `agent_call` — one tool-iteration: assistant content + the tool call/
 *    result it triggered. Replay rebuilds `currentMessages` for the next LLM
 *    call without re-firing the tool dispatch (the dispatch cache handles
 *    that).
 *  - `orchestrator` — one round: the planner's reasoning + every delegation's
 *    outcome + a final-answer hint. Replay restores the `rounds` array; the
 *    next planner call sees them as prior context.
 *  - `reflect` — one iteration: the draft after this round's revision +
 *    convergence flag. Replay restores the latest draft and resumes the loop.
 */
export type TurnEntry = AgentCallTurn | OrchestratorTurn | ReflectTurn;

/**
 * Fields shared by every `agent_call` iteration entry, regardless of phase.
 * Not exported on its own — `AgentCallTurn` is the public union below.
 */
interface AgentCallTurnBase {
  kind: 'agent_call';
  /** 0-indexed tool-iteration counter within the step. Increments per LLM call. */
  index: number;
  /** Outer turn index when in multi-turn mode; absent in single-turn mode. */
  outerTurn?: number;
  /** Assistant content from the LLM response that closed this iteration. */
  assistantContent: string;
  tokensUsed: number;
  costUsd: number;
}

/**
 * A continuing iteration — the assistant called a tool and the dispatched
 * result is captured. Replay re-emits this as the assistant + tool message
 * pair when rebuilding `currentMessages`.
 */
export interface AgentCallTurnContinuing extends AgentCallTurnBase {
  phase: 'continuing';
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  /** The dispatcher's result for `toolCall`, JSON-serialisable. */
  toolResult: unknown;
}

/**
 * A terminal iteration — the assistant produced final content with no tool
 * call (either the LLM declined to call a tool, or a `skipFollowup`
 * capability synthesised the result). Resume short-circuits when the last
 * prior turn is `terminal`.
 */
export interface AgentCallTurnTerminal extends AgentCallTurnBase {
  phase: 'terminal';
}

/**
 * Discriminated by `phase`. The 2 valid runtime states are continuing
 * (toolCall + toolResult required) and terminal (both absent). The split
 * makes one-sided entries (toolCall without toolResult, etc.) unrepresentable
 * — both at the TS layer and after Zod parse.
 */
export type AgentCallTurn = AgentCallTurnContinuing | AgentCallTurnTerminal;

export interface OrchestratorTurn {
  kind: 'orchestrator';
  /** 1-indexed round number, matching the `rounds` array shape. */
  round: number;
  plannerReasoning?: string;
  delegations: Array<{
    agentSlug: string;
    message: string;
    output: unknown;
    tokensUsed: number;
    costUsd: number;
    error?: string;
  }>;
  plannerTokensUsed: number;
  plannerCostUsd: number;
  /** Final answer if the planner returned one this round (signals stop). */
  finalAnswer?: string;
}

export interface ReflectTurn {
  kind: 'reflect';
  /** 0-indexed iteration counter. */
  iteration: number;
  /** Draft text after this iteration's critique/revision. */
  draft: string;
  /** True when this iteration triggered the convergence stop ("no further changes"). */
  converged: boolean;
  tokensUsed: number;
  costUsd: number;
}

export interface ExecutionTraceEntry {
  stepId: string;
  stepType: WorkflowStepType;
  label: string;
  status: 'completed' | 'failed' | 'skipped' | 'awaiting_approval' | 'rejected';
  output: unknown;
  error?: string;
  /**
   * Set by the engine when a skipped step's config carries
   * `expectedSkip: true`. Lets the trace viewer style routine optional
   * skips (missing API key, missing allowlist host) differently from
   * unexpected failures that happened to land on a `skip` strategy.
   */
  expectedSkip?: boolean;
  tokensUsed: number;
  costUsd: number;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  /**
   * Snapshot of the step's resolved config at execution time. Mirrors
   * `step.config` (post-validation) so the trace viewer can show what the
   * step received without joining back through the workflow definition.
   */
  input?: unknown;
  /**
   * Resolved model id for the step's LLM work, if any. For multi-turn
   * executors (`agent_call`, `orchestrator`) this is the model used for the
   * final turn. Absent for non-LLM steps.
   */
  model?: string;
  /** Resolved provider slug. Same shape rules as `model`. */
  provider?: string;
  /** Sum of input tokens across every LLM turn the step issued. */
  inputTokens?: number;
  /** Sum of output tokens across every LLM turn the step issued. */
  outputTokens?: number;
  /**
   * Wall-clock spent inside LLM calls. The difference `durationMs - llmDurationMs`
   * approximates engine + tool I/O overhead. Absent for non-LLM steps.
   */
  llmDurationMs?: number;
  /**
   * Bounded-retry events fired from this step. Each entry corresponds to one
   * `step_retry` event the engine yielded after the executor returned. When
   * `exhausted` is true the retry budget was spent and `targetStepId` points
   * at the sibling fallback edge instead of the retry target.
   */
  retries?: Array<{
    attempt: number;
    maxRetries: number;
    reason: string;
    targetStepId: string;
    exhausted?: boolean;
  }>;
  /**
   * Per-turn checkpoints for multi-turn step types. Absent for single-shot
   * steps. Populated from the engine's in-memory accumulator on step
   * termination, so a completed multi-turn step's full turn history is
   * preserved in the trace for the admin viewer.
   */
  turns?: TurnEntry[];
  /**
   * Source attribution lifted from `output.sources` by the engine. See
   * `lib/orchestration/provenance/types.ts` for the contract. Absent when
   * the step's output didn't carry a valid `sources` array. The trace
   * viewer and structured approval UI render this as pills with hover
   * detail; it is the workflow-step analogue of chat citations.
   */
  provenance?: ProvenanceItem[];
}

/**
 * One decided human-approval step, flattened for the admin history view.
 * Derived from the `human_approval` trace entries on a workflow execution
 * after they've transitioned out of `awaiting_approval`. Multiple rows can
 * come from a single execution if its workflow has more than one approval
 * gate.
 */
export interface ApprovalHistoryEntry {
  /** Synthetic id: `<executionId>:<stepId>`. Stable across pagination. */
  id: string;
  executionId: string;
  workflowId: string;
  workflowName: string;
  stepId: string;
  stepLabel: string;
  decision: 'approved' | 'rejected';
  /** Coarse-grained channel the decision came in through. */
  medium: 'admin' | 'token-external' | 'token-chat' | 'token-embed' | 'unknown';
  /** Resolved when `medium === 'admin'` and the user still exists. */
  approverUserId: string | null;
  approverName: string | null;
  /** Raw `actor` value from the trace entry's output (debugging surface). */
  actorLabel: string | null;
  /** Optional admin notes (approve) or required reason (reject). */
  notes: string | null;
  reason: string | null;
  /** When the engine paused execution and asked for a decision. */
  askedAt: string;
  /** When the decision was recorded. */
  decidedAt: string;
  /** `decidedAt - askedAt`, in milliseconds. */
  waitDurationMs: number;
}

/**
 * One LLM turn's telemetry, accumulated on `ExecutionContext.stepTelemetry`
 * during step execution. The engine drains the array after the executor
 * returns and rolls it into the step's trace entry.
 *
 * Each call site (`runLlmCall`, `agent_call`'s `runSingleTurn`) appends one
 * entry per `provider.chat()` invocation.
 */
export interface LlmTelemetryEntry {
  /** Model id used for this turn (resolved). */
  model: string;
  /** Provider slug used for this turn (resolved, may be a fallback). */
  provider: string;
  /** Input tokens reported by the provider for this turn. */
  inputTokens: number;
  /** Output tokens reported by the provider for this turn. */
  outputTokens: number;
  /** Wall-clock time spent inside `provider.chat()` for this turn, in ms. */
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
  /**
   * If true, the step was skipped due to the `skip` error strategy.
   * The engine records a `'skipped'` trace entry instead of `'completed'`.
   */
  skipped?: boolean;
  /**
   * When `skipped` is true, carries the sanitised error message so the
   * parallel batch handler can emit a `step_failed` SSE event.
   */
  skipError?: string;
  /**
   * Mirrors `step.config.expectedSkip`. When true, the workflow author
   * explicitly marked this skip as routine (e.g. an optional enrichment
   * step whose dependency is missing); the engine carries it onto the
   * trace entry so the viewer can tone the row down.
   */
  expectedSkip?: boolean;
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
  | {
      type: 'capability_result';
      capabilitySlug: string;
      result: unknown;
      /**
       * Admin-only diagnostic payload — populated when the chat request
       * sets `includeTrace: true`. Carries the validated arguments, the
       * dispatch latency, success state and any error code so internal
       * surfaces (learning lab, agent test tab, evaluation runner) can
       * render an inline `<MessageTrace>` strip under the assistant turn.
       * Omitted for consumer surfaces so tool arguments never leak.
       */
      trace?: ToolCallTrace;
    }
  | {
      type: 'capability_results';
      results: Array<{ capabilitySlug: string; result: unknown; trace?: ToolCallTrace }>;
    }
  | { type: 'warning'; code: string; message: string }
  | { type: 'content_reset'; reason: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'approval_required'; pendingApproval: PendingApproval }
  | {
      type: 'done';
      tokenUsage: TokenUsage;
      costUsd: number;
      provider?: string;
      model?: string;
      /**
       * Admin-only: per-component estimate of input-token usage so the
       * UI can show why a small user message can still cost hundreds
       * of tokens (system prompt, tool schemas, history, etc.).
       *
       * Only present when the request opted in via `includeTrace: true`.
       * The total is an *estimate* via the model's tokeniser; it should
       * be close to but not identical to `tokenUsage.inputTokens`.
       */
      inputBreakdown?: InputBreakdown;
      /**
       * Additional models invoked during this turn beyond the main chat
       * LLM — embeddings fired by `search_knowledge_base`, the rolling
       * conversation summariser, etc. Aggregated server-side so the
       * cost summary can mention them without per-call plumbing on the
       * client. Empty / absent when no side-effect models ran.
       */
      sideEffectModels?: SideEffectModelUsage[];
    }
  | { type: 'error'; code: string; message: string };

/**
 * A model invocation that happened during a chat turn but isn't the
 * main LLM completion. Surfaces in the admin cost-summary strip so
 * operators can see *all* the model spend for a turn — currently
 * `embedding` (per `search_knowledge_base` query and per persisted
 * message) and `summarizer` (when the rolling history-summary path
 * fires) populate this list. `costUsd` may be `0` for local providers
 * (Ollama, etc.) or when the model is missing from the registry.
 */
export interface SideEffectModelUsage {
  kind: 'embedding' | 'summarizer';
  model: string;
  provider?: string;
  /** Number of distinct calls aggregated into this entry (defaults to 1). */
  callCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * One slice of input-token usage attributed to a specific source
 * (system prompt, tool definitions, history, user message, …).
 *
 * `content` is the exact text that was tokenised. It may be omitted for
 * categories where the raw text is too large to ship or already
 * available elsewhere (e.g. the conversation history — visible in the
 * chat bubbles already).
 */
export interface InputBreakdownPart {
  tokens: number;
  chars: number;
  content?: string;
}

/**
 * Per-component breakdown of the input prompt sent to the LLM for one
 * turn. All sections are optional except `systemPrompt` and
 * `userMessage` — those two always exist. Values are estimates from
 * the model's tokeniser and should be treated as approximate.
 */
export interface InputBreakdown {
  systemPrompt: InputBreakdownPart;
  contextBlock?: InputBreakdownPart;
  userMemories?: InputBreakdownPart & { count: number };
  conversationSummary?: InputBreakdownPart;
  /**
   * Conversation history (prior user/assistant/tool turns). Content
   * omitted because it's already visible in the chat thread above.
   */
  conversationHistory?: InputBreakdownPart & {
    messageCount: number;
    droppedCount: number;
  };
  /** Tool / capability definitions serialised as JSON schemas. */
  toolDefinitions?: InputBreakdownPart & { count: number; names: string[] };
  /** Estimated tokens consumed by binary attachments (images, PDFs). */
  attachments?: { tokens: number; count: number };
  userMessage: InputBreakdownPart;
  /**
   * Per-message scaffolding the provider adds around our content: role
   * markers, message delimiters, the tool envelope, assistant priming,
   * and any tokeniser drift the local estimate doesn't capture.
   *
   * Computed as `usage.inputTokens − sum(other sections)` on the
   * `done` event so the breakdown total always equals the model's
   * reported input-token count exactly. Omitted when the LLM call
   * failed before usage was reported (then `totalEstimated` falls back
   * to the local-estimator sum).
   */
  framingOverhead?: InputBreakdownPart;
  /**
   * Total input tokens for the turn. After reconciliation against the
   * model's reported `usage.inputTokens`, this equals the model's count
   * exactly; before reconciliation it's the local-estimator sum.
   */
  totalEstimated: number;
}

/**
 * Inline diagnostic captured per capability dispatch for admin chat
 * surfaces. Mirrors what the dispatcher already records internally
 * (args, latency, success) plus the resolved USD cost figure when the
 * underlying `logCost` calculation is reusable.
 *
 * Persisted on the assistant message as `MessageMetadata.toolCalls` so
 * the post-hoc conversation trace viewer can render the same component
 * without recomputing from tool-role messages.
 */
export interface ToolCallTrace {
  /** Capability slug, e.g. `search_knowledge_base`. */
  slug: string;
  /** Validated arguments the LLM passed to the capability. */
  arguments: unknown;
  /** Wall-clock dispatch duration. */
  latencyMs: number;
  /** USD cost attributed to this call when known; omitted otherwise. */
  costUsd?: number;
  success: boolean;
  errorCode?: string;
  /**
   * Truncated stringified result for inline preview — kept compact so
   * persisted JSON metadata stays well under Prisma's column budget.
   */
  resultPreview?: string;
  /**
   * If the capability invoked a secondary model (e.g. the embedding
   * model for `search_knowledge_base`), describe that call here so the
   * chat handler can roll it up into the turn's
   * {@link SideEffectModelUsage} aggregate. Stored per-call here so
   * the post-hoc trace viewer can attribute it to the originating tool;
   * the aggregated total goes on the assistant message metadata
   * separately.
   */
  sideEffectModel?: SideEffectModelUsage;
}

/**
 * Carried on `approval_required` ChatEvent and persisted on
 * `MessageMetadata.pendingApproval` so chat reloads recover the card.
 *
 * Tokens are HMAC strings (see `lib/orchestration/approval-tokens.ts`).
 * The chat surface — admin or embed widget — builds the final URL at
 * POST time, pointing at its channel-specific sub-route
 * (`…/approve/chat`, `…/approve/embed`). Keeping tokens here rather
 * than full URLs makes the persisted shape channel-agnostic across
 * future surfaces (MCP, CLI).
 */
export interface PendingApproval {
  executionId: string;
  stepId: string;
  prompt: string;
  /** ISO 8601 token expiry. */
  expiresAt: string;
  approveToken: string;
  rejectToken: string;
}

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
  /**
   * Source attributions that grounded the assistant response. Markers
   * here align with `[N]` references in the message `content`. Empty or
   * absent for non-RAG turns.
   */
  citations?: Citation[];
  /**
   * Set on the synthetic assistant message persisted when a workflow
   * triggered via the `run_workflow` capability paused on a
   * `human_approval` step. Drives the in-chat approval card and lets a
   * reload recover the pending state. Cleared by the chat surface once
   * the underlying execution row reaches a terminal state.
   */
  pendingApproval?: PendingApproval;
  /**
   * Per-tool dispatch diagnostics aggregated across the assistant
   * turn. Populated only when the chat request opts in via
   * `includeTrace: true` (admin internal surfaces). Drives the inline
   * `<MessageTrace>` strip both live (during streaming) and post-hoc
   * (in the conversation trace viewer).
   */
  toolCalls?: ToolCallTrace[];
  /**
   * Additional model invocations during the turn beyond the main LLM
   * (embeddings, the rolling summariser). Mirrors the `done` event's
   * `sideEffectModels` field so the cost-summary strip can render the
   * full picture even on reloads / when replayed from history.
   */
  sideEffectModels?: SideEffectModelUsage[];
  // Present on tool messages
  toolCall?: { id: string; name: string; arguments: unknown };
  result?: unknown;
  // Present on error-marker messages (persisted when streaming fails completely)
  error?: boolean;
  errorCode?: string;
}

/**
 * A source attribution surfaced by an agent response.
 *
 * Citations map a numeric marker (e.g. `[1]`, `[2]`) the LLM emits in
 * its content to the underlying knowledge-base chunk it was drawn from.
 * The streaming chat handler accumulates them across the tool loop,
 * exposes the marker to the LLM via a `marker` field on each tool
 * result item (so the model can reference them in prose), persists the
 * envelope onto the assistant message metadata, and emits a `citations`
 * event before `done` so clients can render a sources panel.
 */
export interface Citation {
  /** Monotonic marker assigned by the chat handler (1-indexed). */
  marker: number;
  chunkId: string;
  documentId: string;
  documentName: string | null;
  /** Section heading, or "Page N" for PDF-derived chunks. */
  section: string | null;
  patternNumber: number | null;
  patternName: string | null;
  /** Truncated excerpt of the source chunk for verification UI. */
  excerpt: string;
  /** Combined ranking score, normalised to [0, 1]. */
  similarity: number;
  /** Hybrid mode only: (1 − cosine_distance) component before weighting. */
  vectorScore?: number;
  /** Hybrid mode only: ts_rank_cd BM25-flavoured component before weighting. */
  keywordScore?: number;
  /** Hybrid mode only: blended `vectorWeight × vectorScore + bm25Weight × keywordScore`. */
  finalScore?: number;
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

/**
 * `AiWorkflow` plus the joined published version, returned by the single-
 * workflow endpoints. The builder reads the snapshot from `publishedVersion`
 * (or `draftDefinition` when present) — the legacy `workflowDefinition`
 * column has been removed.
 */
export type AiWorkflowWithVersion = AiWorkflow & {
  publishedVersion: AiWorkflowVersion | null;
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

/** Enriched knowledge-tag row returned by the list endpoint. */
export interface KnowledgeTagListItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  documentCount: number;
  agentCount: number;
}

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

/**
 * Lightweight tag reference returned inline on each document by the admin
 * documents list endpoint. The full KnowledgeTag row carries description and
 * timestamps; the table only needs id/slug/name to render chips.
 */
export interface DocumentTagRef {
  id: string;
  slug: string;
  name: string;
}

/**
 * Shape returned by `GET /admin/orchestration/knowledge/documents` for each
 * row. Same as the Prisma row plus inline tags (flattened from the join
 * table) so the admin table can render tag chips without a per-row fetch.
 */
export type KnowledgeDocumentListItem = AiKnowledgeDocument & {
  tags?: DocumentTagRef[];
  /**
   * Distinct BM25 keyword count across this document's chunks. Computed
   * server-side via `string_to_array` + `unnest` on
   * `AiKnowledgeChunk.keywords`. Drives the "BM25 keywords" column on
   * the admin documents table; clicking opens a modal that lists the
   * keywords and offers post-upload enrichment.
   */
  distinctKeywordCount?: number;
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
export const TASK_TYPES = ['routing', 'chat', 'reasoning', 'embeddings', 'audio'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Tunable weights for knowledge-base search. All fields are optional —
 * `resolveSearchWeights` in `lib/orchestration/knowledge/search.ts` falls
 * back to built-in defaults for any field that is absent. This lets the
 * admin form persist partial overrides (e.g. just `hybridEnabled: true`).
 */
export interface SearchConfig {
  /**
   * Vector-only mode: cosine-distance reduction for keyword-matching chunks
   * (non-positive, e.g. -0.02). Ignored when `hybridEnabled` is true.
   */
  keywordBoostWeight?: number;
  /** Multiplier applied to the vector similarity score (e.g. 1.0). Used in both modes. */
  vectorWeight?: number;
  /**
   * When true, switch to hybrid (BM25-flavoured + vector) ranking using
   * `vectorWeight × vector_score + bm25Weight × ts_rank_cd(searchVector, …)`.
   * When false/undefined, behaviour is byte-for-byte the legacy vector-only path.
   */
  hybridEnabled?: boolean;
  /**
   * Multiplier on the keyword (BM25-flavoured) score when hybrid is enabled.
   * Range 0.1–2.0; defaults to 1.0 when `hybridEnabled` is true and no value set.
   * Ignored when `hybridEnabled` is false/undefined.
   */
  bm25Weight?: number;
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
  /**
   * Hydrated map of `TaskType` → canonical model id. Empty stored slots
   * are filled from `computeDefaultModelMap()` so runtime callers (chat
   * handler, etc.) always have a value. Use `defaultModelsStored` to
   * see what the operator actually saved.
   */
  defaultModels: Record<TaskType, string>;
  /**
   * Raw stored map — only contains keys the operator has explicitly
   * saved. Missing or empty-string entries mean "not set". UIs that
   * need to distinguish "saved" from "system suggestion" (settings
   * form, wizard's `persistSuggestedDefaults`) should read this; the
   * runtime resolver should keep using `defaultModels`.
   */
  defaultModelsStored: Partial<Record<TaskType, string>>;
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
  /** Input guard behaviour for prompt injection detection. `null` = disabled. */
  inputGuardMode: InputGuardMode | null;
  /** Output guard behaviour for topic boundary enforcement. `null` = disabled. */
  outputGuardMode: OutputGuardMode | null;
  /**
   * Citation guard behaviour. Validates that responses grounded in
   * retrieved knowledge include `[N]` markers matching the citation
   * envelope. `null` = inherit `log_only`.
   */
  citationGuardMode: OutputGuardMode | null;
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
  /**
   * Allowlist of origins permitted to call the public embed-channel
   * approval endpoints (`/api/v1/orchestration/approvals/:id/{approve,reject}/embed`).
   * Empty array (default) means no embed-channel approval requests are
   * accepted — admins must opt in by adding the customer site origins
   * before in-chat approvals will work from a partner site.
   */
  embedAllowedOrigins: string[];
  /**
   * Org-wide kill switch for the voice-input feature. Default `true` —
   * agents with `enableVoiceInput=true` get the mic surface. Flip to
   * `false` to disable transcription across every agent at once
   * (incident response, compliance pause, pre-launch sandbox) without
   * editing each agent row.
   */
  voiceInputGloballyEnabled: boolean;
  /**
   * Org-wide kill switch for image attachments on chat. Default `true`
   * — agents with `enableImageInput=true` get the attach affordance.
   * Flip to `false` to disable image input across every agent at once
   * without editing each agent row.
   */
  imageInputGloballyEnabled: boolean;
  /**
   * Org-wide kill switch for PDF / document attachments on chat.
   * Default `true` — agents with `enableDocumentInput=true` get the
   * attach affordance for PDFs. Flip to `false` to disable document
   * input across every agent at once.
   */
  documentInputGloballyEnabled: boolean;
  /**
   * FK to `AiProviderModel.id` — the embedding model the vector
   * columns are currently sized for. Null means "use the legacy
   * provider-priority resolver"; the operator hasn't picked yet.
   *
   * Changing this requires running `npm run embeddings:reset` and
   * re-uploading documents because pgvector locks dimension at the
   * column level. See `lib/orchestration/knowledge/embedder.ts`.
   */
  activeEmbeddingModelId: string | null;
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
  /**
   * Combined ranking score, normalised to [0, 1] (higher = more relevant).
   * In vector-only mode, derived from cosine similarity + keyword boost.
   * In hybrid mode, the blended `vectorWeight × vector_score + bm25Weight × keyword_score`.
   */
  similarity: number;
  documentName?: string;
  /** Hybrid mode only: the (1 - cosine_distance) component before weighting. */
  vectorScore?: number;
  /** Hybrid mode only: the ts_rank_cd BM25-flavoured score before weighting. */
  keywordScore?: number;
  /** Hybrid mode only: the blended score `vectorWeight × vectorScore + bm25Weight × keywordScore`. */
  finalScore?: number;
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
  /** Pattern number from the canonical 21 agentic design patterns (1–21). */
  number: number;
  /** Display name — must match the canonical name or a registered alias in `KNOWN_PATTERNS`. */
  name: string;
}

/**
 * One of the 21 canonical Agentic Design Patterns.
 *
 * Sourced from `prisma/seeds/data/chunks/chunks.json` (the seed data that
 * loads the patterns into the orchestration knowledge base) which mirrors
 * Antonio Gullí's *Agentic Design Patterns*. The same numbering appears in
 * `.claude/skills/orchestration-agent-architect/references/patterns-{1-to-10,11-to-21}.md`.
 *
 * `aliases` holds the short display names templates may use as a substitute
 * for the canonical name (e.g. "RAG" for "Knowledge Retrieval (RAG)").
 * Both are accepted by `isValidPatternReference()`.
 */
export interface KnownPattern {
  readonly number: number;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
}

/**
 * The 21 canonical Agentic Design Patterns — single source of truth.
 *
 * A drift test in `tests/unit/types/orchestration-patterns.test.ts` asserts
 * this constant agrees with the chunk metadata in
 * `prisma/seeds/data/chunks/chunks.json`. If they diverge the test fails.
 */
export const KNOWN_PATTERNS: readonly KnownPattern[] = [
  { number: 1, canonicalName: 'Prompt Chaining', aliases: [] },
  { number: 2, canonicalName: 'Routing', aliases: [] },
  { number: 3, canonicalName: 'Parallelisation', aliases: [] },
  { number: 4, canonicalName: 'Reflection', aliases: [] },
  { number: 5, canonicalName: 'Tool Use', aliases: [] },
  { number: 6, canonicalName: 'Planning', aliases: [] },
  { number: 7, canonicalName: 'Multi-Agent Collaboration', aliases: ['Multi-Agent'] },
  { number: 8, canonicalName: 'Memory Management', aliases: ['Memory'] },
  { number: 9, canonicalName: 'Learning & Adaptation', aliases: [] },
  { number: 10, canonicalName: 'State Management (MCP)', aliases: ['MCP'] },
  { number: 11, canonicalName: 'Goal Setting & Monitoring', aliases: [] },
  { number: 12, canonicalName: 'Exception Handling & Recovery', aliases: [] },
  { number: 13, canonicalName: 'Human-in-the-Loop', aliases: ['HITL'] },
  { number: 14, canonicalName: 'Knowledge Retrieval (RAG)', aliases: ['RAG'] },
  {
    number: 15,
    canonicalName: 'Inter-Agent Communication (A2A)',
    aliases: ['A2A', 'Inter-Agent Communication'],
  },
  { number: 16, canonicalName: 'Resource-Aware Optimisation', aliases: [] },
  { number: 17, canonicalName: 'Reasoning Techniques', aliases: [] },
  { number: 18, canonicalName: 'Guardrails & Safety', aliases: ['Guardrails'] },
  { number: 19, canonicalName: 'Evaluation & Monitoring', aliases: ['Evaluation'] },
  { number: 20, canonicalName: 'Prioritisation', aliases: [] },
  { number: 21, canonicalName: 'Exploration & Discovery', aliases: [] },
] as const;

/**
 * Returns true iff `(number, name)` matches a `KNOWN_PATTERNS` entry's
 * `number` and either its `canonicalName` or one of its `aliases`.
 */
export function isValidPatternReference(number: number, name: string): boolean {
  const known = KNOWN_PATTERNS.find((p) => p.number === number);
  if (!known) return false;
  return name === known.canonicalName || known.aliases.includes(name);
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

/** Provider tier roles for the selection matrix decision heuristic.
 *
 * Until 2026-05-16 this enum included `local_sovereign`, which conflated
 * deployment locus with capability tier. The audit workflow repeatedly
 * produced wrong proposals (e.g. labelling Qwen2.5-72B as an embedding
 * engine) because the enum forced false choices. Deployment locus now
 * lives in `deploymentProfiles` (see {@link DEPLOYMENT_PROFILES}); the
 * tier role is restricted to actual capability classification. */
export const TIER_ROLES = [
  'thinking',
  'worker',
  'infrastructure',
  'control_plane',
  'embedding',
] as const;
export type TierRole = (typeof TIER_ROLES)[number];

/** Deployment locus profiles — orthogonal to {@link TIER_ROLES}.
 *
 * A model can carry one or more profiles. `hosted` is the most common
 * (vendor-managed API); `sovereign` means the operator's own
 * infrastructure. Designed for future expansion (`edge`, `air_gapped`)
 * without breaking the enum semantics. */
export const DEPLOYMENT_PROFILES = ['hosted', 'sovereign'] as const;
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

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

/** Model capability types storable in the matrix.
 *
 * Excludes `unknown`, which is a discovery-only placeholder for models
 * whose role can't be inferred from id. The catalogue (live `/v1/models`
 * fetch) renders `unknown`; the curated matrix does not.
 *
 * Runtime paths exist for `chat`, `reasoning` (via `chat()`),
 * `embedding`, `audio` (via optional `transcribe()`), `vision` (image
 * parts in `chat()`), and `documents` (PDF parts in `chat()`). `image`
 * (generation — DALL-E, gpt-image, Imagen) and `moderation` are
 * storage-only — operators can register rows so they appear in audits
 * and inventory, but the engine does not invoke them.
 *
 * Note: `image` means image *generation*; `vision` means image *input*
 * to a chat model. They are distinct capabilities on different models.
 */
export const MODEL_CAPABILITIES = [
  'chat',
  'reasoning',
  'embedding',
  'audio',
  'image',
  'moderation',
  'vision',
  'documents',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** Capabilities the orchestration engine does not invoke at runtime.
 *
 * The form and matrix surface a "storage-only" note on rows whose
 * capability set is a subset of this list. If an engine path is ever
 * added for one of these capabilities, update both this constant and
 * the UI notes in lockstep.
 */
export const STORAGE_ONLY_CAPABILITIES = [
  'image',
  'moderation',
] as const satisfies readonly ModelCapability[];
export type StorageOnlyCapability = (typeof STORAGE_ONLY_CAPABILITIES)[number];

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
  embedding: {
    label: 'Embedding',
    description: 'Vector embedding models for semantic search and retrieval',
  },
};

/** Human-readable deployment-profile metadata for display. */
export const DEPLOYMENT_PROFILE_META: Record<
  DeploymentProfile,
  { label: string; description: string }
> = {
  hosted: {
    label: 'Hosted',
    description: 'Vendor-managed API — no local infrastructure required',
  },
  sovereign: {
    label: 'Sovereign',
    description:
      "Runs on the operator's own infrastructure — for privacy, compliance, or offline capability",
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
