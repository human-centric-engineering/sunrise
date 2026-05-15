/**
 * Centralized API Endpoint Constants
 *
 * All API paths used by client components and server component fetches.
 * Import from here instead of hardcoding paths in components.
 *
 * @example
 * ```typescript
 * import { API } from '@/lib/api/endpoints';
 *
 * // Client component
 * const user = await apiClient.get<User>(API.USERS.ME);
 *
 * // Server component
 * const res = await serverFetch(API.ADMIN.STATS);
 * ```
 */

export const API = {
  /** Auth endpoints (better-auth) */
  AUTH: {
    /** better-auth catch-all */
    BASE: '/api/auth',
    SIGN_OUT: '/api/auth/sign-out',
  },

  /** Current user endpoints */
  USERS: {
    ME: '/api/v1/users/me',
    ME_PREFERENCES: '/api/v1/users/me/preferences',
    ME_AVATAR: '/api/v1/users/me/avatar',
    /** User by ID (admin) */
    byId: (id: string): string => `/api/v1/users/${id}`,
    /** User list (admin) */
    LIST: '/api/v1/users',
    /** Send invitation (admin) */
    INVITE: '/api/v1/users/invite',
  },

  /** Invitation endpoints (public, token-gated) */
  INVITATIONS: {
    METADATA: '/api/v1/invitations/metadata',
  },

  /** Admin endpoints */
  ADMIN: {
    STATS: '/api/v1/admin/stats',
    LOGS: '/api/v1/admin/logs',
    INVITATIONS: '/api/v1/admin/invitations',
    /** Delete invitation by email */
    invitationByEmail: (email: string): string =>
      `/api/v1/admin/invitations/${encodeURIComponent(email)}`,
    FEATURE_FLAGS: '/api/v1/admin/feature-flags',
    /** Feature flag by ID */
    featureFlag: (id: string): string => `/api/v1/admin/feature-flags/${id}`,

    /** AI Orchestration admin endpoints (Phase 3 / Phase 4) */
    ORCHESTRATION: {
      AGENTS: '/api/v1/admin/orchestration/agents',
      AGENTS_BULK: '/api/v1/admin/orchestration/agents/bulk',
      AGENTS_COMPARE: '/api/v1/admin/orchestration/agents/compare',
      AGENTS_EXPORT: '/api/v1/admin/orchestration/agents/export',
      AGENTS_IMPORT: '/api/v1/admin/orchestration/agents/import',
      agentById: (id: string): string => `/api/v1/admin/orchestration/agents/${id}`,
      agentClone: (id: string): string => `/api/v1/admin/orchestration/agents/${id}/clone`,
      agentBudget: (id: string): string => `/api/v1/admin/orchestration/agents/${id}/budget`,
      agentCapabilities: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/capabilities`,
      agentCapabilityById: (id: string, capId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/capabilities/${capId}`,
      agentCapabilitiesUsage: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/capabilities/usage`,
      agentInstructionsHistory: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/instructions-history`,
      agentInstructionsRevert: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/instructions-revert`,
      agentInviteTokens: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/invite-tokens`,
      agentInviteTokenById: (id: string, tokenId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/invite-tokens/${tokenId}`,
      agentVersions: (id: string): string => `/api/v1/admin/orchestration/agents/${id}/versions`,
      agentVersionById: (id: string, versionId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/versions/${versionId}`,
      agentVersionRestore: (id: string, versionId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/versions/${versionId}/restore`,
      agentEmbedTokens: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/embed-tokens`,
      agentEmbedTokenById: (id: string, tokenId: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/embed-tokens/${tokenId}`,
      agentWidgetConfig: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/widget-config`,
      CAPABILITIES: '/api/v1/admin/orchestration/capabilities',
      capabilityById: (id: string): string => `/api/v1/admin/orchestration/capabilities/${id}`,
      capabilityAgents: (id: string): string =>
        `/api/v1/admin/orchestration/capabilities/${id}/agents`,
      capabilityStats: (id: string): string =>
        `/api/v1/admin/orchestration/capabilities/${id}/stats`,
      PROVIDER_MODELS: '/api/v1/admin/orchestration/provider-models',
      providerModelById: (id: string): string =>
        `/api/v1/admin/orchestration/provider-models/${id}`,
      PROVIDER_MODELS_BULK: '/api/v1/admin/orchestration/provider-models/bulk',
      PROVIDER_MODEL_RECOMMEND: '/api/v1/admin/orchestration/provider-models/recommend',
      DISCOVERY_MODELS: '/api/v1/admin/orchestration/discovery/models',
      PROVIDERS: '/api/v1/admin/orchestration/providers',
      PROVIDERS_DETECT: '/api/v1/admin/orchestration/providers/detect',
      PROVIDERS_TEST_BULK: '/api/v1/admin/orchestration/providers/test-bulk',
      providerById: (id: string): string => `/api/v1/admin/orchestration/providers/${id}`,
      providerTest: (id: string): string => `/api/v1/admin/orchestration/providers/${id}/test`,
      providerTestModel: (id: string): string =>
        `/api/v1/admin/orchestration/providers/${id}/test-model`,
      providerModels: (id: string): string => `/api/v1/admin/orchestration/providers/${id}/models`,
      providerHealth: (id: string): string => `/api/v1/admin/orchestration/providers/${id}/health`,
      MODELS: '/api/v1/admin/orchestration/models',
      WORKFLOWS: '/api/v1/admin/orchestration/workflows',
      workflowById: (id: string): string => `/api/v1/admin/orchestration/workflows/${id}`,
      workflowSchedules: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/schedules`,
      workflowScheduleById: (workflowId: string, scheduleId: string): string =>
        `/api/v1/admin/orchestration/workflows/${workflowId}/schedules/${scheduleId}`,
      workflowValidate: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/validate`,
      workflowDryRun: (id: string): string => `/api/v1/admin/orchestration/workflows/${id}/dry-run`,
      workflowExecute: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/execute`,
      workflowExecuteStream: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/execute-stream`,
      workflowSaveAsTemplate: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/save-as-template`,
      EXECUTIONS: '/api/v1/admin/orchestration/executions',
      executionById: (id: string): string => `/api/v1/admin/orchestration/executions/${id}`,
      executionStatus: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/status`,
      executionLive: (id: string): string => `/api/v1/admin/orchestration/executions/${id}/live`,
      executionApprove: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/approve`,
      executionReject: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/reject`,
      executionCancel: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/cancel`,
      executionRetryStep: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/retry-step`,
      workflowVersions: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/versions`,
      workflowVersionById: (id: string, version: number): string =>
        `/api/v1/admin/orchestration/workflows/${id}/versions/${version}`,
      workflowPublish: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/publish`,
      workflowDiscardDraft: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/discard-draft`,
      workflowRollback: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/rollback`,
      CHAT_STREAM: '/api/v1/admin/orchestration/chat/stream',
      CONVERSATIONS: '/api/v1/admin/orchestration/conversations',
      conversationById: (id: string): string => `/api/v1/admin/orchestration/conversations/${id}`,
      conversationMessages: (id: string): string =>
        `/api/v1/admin/orchestration/conversations/${id}/messages`,
      CONVERSATIONS_CLEAR: '/api/v1/admin/orchestration/conversations/clear',
      CONVERSATIONS_EXPORT: '/api/v1/admin/orchestration/conversations/export',
      CONVERSATIONS_SEARCH: '/api/v1/admin/orchestration/conversations/search',
      KNOWLEDGE_DOCUMENTS: '/api/v1/admin/orchestration/knowledge/documents',
      knowledgeDocumentById: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}`,
      knowledgeDocumentRechunk: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/rechunk`,
      knowledgeDocumentEnrichKeywords: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/enrich-keywords`,
      knowledgeDocumentRetry: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/retry`,
      knowledgeDocumentConfirm: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/confirm`,
      knowledgeDocumentChunks: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/chunks`,
      KNOWLEDGE_SEARCH: '/api/v1/admin/orchestration/knowledge/search',
      KNOWLEDGE_GRAPH: '/api/v1/admin/orchestration/knowledge/graph',
      KNOWLEDGE_EMBEDDINGS: '/api/v1/admin/orchestration/knowledge/embeddings',
      KNOWLEDGE_PATTERNS: '/api/v1/admin/orchestration/knowledge/patterns',
      knowledgePatternByNumber: (num: number): string =>
        `/api/v1/admin/orchestration/knowledge/patterns/${num}`,
      KNOWLEDGE_SEED: '/api/v1/admin/orchestration/knowledge/seed',
      EMBEDDING_MODELS: '/api/v1/admin/orchestration/embedding-models',
      KNOWLEDGE_EMBED: '/api/v1/admin/orchestration/knowledge/embed',
      KNOWLEDGE_EMBEDDING_STATUS: '/api/v1/admin/orchestration/knowledge/embedding-status',
      KNOWLEDGE_TAGS: '/api/v1/admin/orchestration/knowledge/tags',
      knowledgeTagById: (id: string): string => `/api/v1/admin/orchestration/knowledge/tags/${id}`,
      WEBHOOKS: '/api/v1/admin/orchestration/webhooks',
      webhookById: (id: string): string => `/api/v1/admin/orchestration/webhooks/${id}`,
      webhookDeliveries: (id: string): string =>
        `/api/v1/admin/orchestration/webhooks/${id}/deliveries`,
      webhookTest: (id: string): string => `/api/v1/admin/orchestration/webhooks/${id}/test`,
      retryDelivery: (id: string): string =>
        `/api/v1/admin/orchestration/webhooks/deliveries/${id}/retry`,
      COSTS: '/api/v1/admin/orchestration/costs',
      COSTS_SUMMARY: '/api/v1/admin/orchestration/costs/summary',
      COSTS_ALERTS: '/api/v1/admin/orchestration/costs/alerts',
      ANALYTICS_TOPICS: '/api/v1/admin/orchestration/analytics/topics',
      ANALYTICS_UNANSWERED: '/api/v1/admin/orchestration/analytics/unanswered',
      ANALYTICS_ENGAGEMENT: '/api/v1/admin/orchestration/analytics/engagement',
      ANALYTICS_CONTENT_GAPS: '/api/v1/admin/orchestration/analytics/content-gaps',
      ANALYTICS_FEEDBACK: '/api/v1/admin/orchestration/analytics/feedback',
      MAINTENANCE_TICK: '/api/v1/admin/orchestration/maintenance/tick',
      SETTINGS: '/api/v1/admin/orchestration/settings',
      EVALUATIONS: '/api/v1/admin/orchestration/evaluations',
      evaluationById: (id: string): string => `/api/v1/admin/orchestration/evaluations/${id}`,
      evaluationComplete: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/${id}/complete`,
      evaluationRescore: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/${id}/rescore`,
      evaluationLogs: (id: string): string => `/api/v1/admin/orchestration/evaluations/${id}/logs`,
      agentEvaluationTrend: (id: string): string =>
        `/api/v1/admin/orchestration/agents/${id}/evaluation-trend`,
      OBSERVABILITY_DASHBOARD_STATS: '/api/v1/admin/orchestration/observability/dashboard-stats',
      QUIZ_SCORES: '/api/v1/admin/orchestration/quiz-scores',

      /** MCP Server admin endpoints */
      MCP_SETTINGS: '/api/v1/admin/orchestration/mcp/settings',
      MCP_TOOLS: '/api/v1/admin/orchestration/mcp/tools',
      mcpToolById: (id: string): string => `/api/v1/admin/orchestration/mcp/tools/${id}`,
      MCP_RESOURCES: '/api/v1/admin/orchestration/mcp/resources',
      mcpResourceById: (id: string): string => `/api/v1/admin/orchestration/mcp/resources/${id}`,
      MCP_KEYS: '/api/v1/admin/orchestration/mcp/keys',
      mcpKeyById: (id: string): string => `/api/v1/admin/orchestration/mcp/keys/${id}`,
      mcpKeyRotate: (id: string): string => `/api/v1/admin/orchestration/mcp/keys/${id}/rotate`,
      MCP_AUDIT: '/api/v1/admin/orchestration/mcp/audit',
      MCP_SESSIONS: '/api/v1/admin/orchestration/mcp/sessions',
      mcpSessionById: (id: string): string => `/api/v1/admin/orchestration/mcp/sessions/${id}`,

      /** Admin audit log */
      AUDIT_LOG: '/api/v1/admin/orchestration/audit-log',
    },
  },

  /** Consumer chat endpoints */
  CHAT: {
    AGENTS: '/api/v1/chat/agents',
    STREAM: '/api/v1/chat/stream',
    CONVERSATIONS: '/api/v1/chat/conversations',
    CONVERSATIONS_SEARCH: '/api/v1/chat/conversations/search',
    conversationById: (id: string): string => `/api/v1/chat/conversations/${id}`,
    conversationMessages: (id: string): string => `/api/v1/chat/conversations/${id}/messages`,
    validateToken: (slug: string): string => `/api/v1/chat/agents/${slug}/validate-token`,
  },

  /** Webhook trigger (API-key authenticated, not admin) */
  WEBHOOKS: {
    trigger: (slug: string): string => `/api/v1/webhooks/trigger/${slug}`,
  },

  /** Public endpoints */
  /** Public orchestration endpoints (token-authenticated, no session) */
  ORCHESTRATION: {
    approvalApprove: (id: string): string => `/api/v1/orchestration/approvals/${id}/approve`,
    approvalReject: (id: string): string => `/api/v1/orchestration/approvals/${id}/reject`,
    /** Chat-channel approval routes — server pins `actorLabel: 'token:chat'` and enforces same-origin CORS. */
    approvalApproveChat: (id: string): string =>
      `/api/v1/orchestration/approvals/${id}/approve/chat`,
    approvalRejectChat: (id: string): string => `/api/v1/orchestration/approvals/${id}/reject/chat`,
    /** Embed-channel approval routes — server pins `actorLabel: 'token:embed'` and enforces a configured origin allowlist. */
    approvalApproveEmbed: (id: string): string =>
      `/api/v1/orchestration/approvals/${id}/approve/embed`,
    approvalRejectEmbed: (id: string): string =>
      `/api/v1/orchestration/approvals/${id}/reject/embed`,
    /** Token-authenticated execution status read — used by chat-rendered approval cards to poll. */
    approvalStatus: (id: string): string => `/api/v1/orchestration/approvals/${id}/status`,
  },
  PUBLIC: {
    HEALTH: '/api/health',
    CONTACT: '/api/v1/contact',
    CSP_REPORT: '/api/csp-report',
  },
} as const;
