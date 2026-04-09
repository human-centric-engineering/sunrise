/**
 * Agent Orchestration Types
 *
 * TypeScript types for the Agent Orchestration Layer including
 * agent configuration, workflows, conversations, knowledge base,
 * evaluation, cost tracking, and provider configuration.
 */

import type {
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
  errorStrategy: 'retry' | 'fallback' | 'fail';
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
  | { type: 'done'; tokenUsage: TokenUsage; costUsd: number }
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

/** Structured metadata stored in AiMessage.metadata */
export interface MessageMetadata {
  tokenUsage?: TokenUsage;
  modelUsed?: string;
  latencyMs?: number;
  costUsd?: number;
}

// ============================================================================
// API Input/Output Types
// ============================================================================

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
  agent: Pick<AiAgent, 'id' | 'name' | 'slug'>;
};

/** Cost summary for a time period */
export interface CostSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  byOperation: Record<string, number>;
  entries: AiCostLog[];
}

/** Provider config with creator info */
export type ProviderConfigWithCreator = AiProviderConfig & {
  creator: Pick<AiAgent, 'id' | 'name'>;
};

/** Knowledge search result */
export interface KnowledgeSearchResult {
  chunk: AiKnowledgeChunk;
  similarity: number;
}

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
};
