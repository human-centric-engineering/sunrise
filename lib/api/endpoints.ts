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
      CAPABILITIES: '/api/v1/admin/orchestration/capabilities',
      capabilityById: (id: string): string => `/api/v1/admin/orchestration/capabilities/${id}`,
      capabilityAgents: (id: string): string =>
        `/api/v1/admin/orchestration/capabilities/${id}/agents`,
      capabilityStats: (id: string): string =>
        `/api/v1/admin/orchestration/capabilities/${id}/stats`,
      PROVIDERS: '/api/v1/admin/orchestration/providers',
      providerById: (id: string): string => `/api/v1/admin/orchestration/providers/${id}`,
      providerTest: (id: string): string => `/api/v1/admin/orchestration/providers/${id}/test`,
      providerTestModel: (id: string): string =>
        `/api/v1/admin/orchestration/providers/${id}/test-model`,
      providerModels: (id: string): string => `/api/v1/admin/orchestration/providers/${id}/models`,
      MODELS: '/api/v1/admin/orchestration/models',
      WORKFLOWS: '/api/v1/admin/orchestration/workflows',
      workflowById: (id: string): string => `/api/v1/admin/orchestration/workflows/${id}`,
      workflowValidate: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/validate`,
      workflowExecute: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/execute`,
      EXECUTIONS: '/api/v1/admin/orchestration/executions',
      executionById: (id: string): string => `/api/v1/admin/orchestration/executions/${id}`,
      executionApprove: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/approve`,
      executionCancel: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/cancel`,
      executionRetryStep: (id: string): string =>
        `/api/v1/admin/orchestration/executions/${id}/retry-step`,
      workflowDefinitionHistory: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/definition-history`,
      workflowDefinitionRevert: (id: string): string =>
        `/api/v1/admin/orchestration/workflows/${id}/definition-revert`,
      CHAT_STREAM: '/api/v1/admin/orchestration/chat/stream',
      CONVERSATIONS: '/api/v1/admin/orchestration/conversations',
      conversationById: (id: string): string => `/api/v1/admin/orchestration/conversations/${id}`,
      conversationMessages: (id: string): string =>
        `/api/v1/admin/orchestration/conversations/${id}/messages`,
      CONVERSATIONS_CLEAR: '/api/v1/admin/orchestration/conversations/clear',
      KNOWLEDGE_DOCUMENTS: '/api/v1/admin/orchestration/knowledge/documents',
      knowledgeDocumentById: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}`,
      knowledgeDocumentRechunk: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/rechunk`,
      knowledgeDocumentRetry: (id: string): string =>
        `/api/v1/admin/orchestration/knowledge/documents/${id}/retry`,
      KNOWLEDGE_SEARCH: '/api/v1/admin/orchestration/knowledge/search',
      KNOWLEDGE_GRAPH: '/api/v1/admin/orchestration/knowledge/graph',
      KNOWLEDGE_PATTERNS: '/api/v1/admin/orchestration/knowledge/patterns',
      knowledgePatternByNumber: (num: number): string =>
        `/api/v1/admin/orchestration/knowledge/patterns/${num}`,
      KNOWLEDGE_SEED: '/api/v1/admin/orchestration/knowledge/seed',
      EMBEDDING_MODELS: '/api/v1/admin/orchestration/embedding-models',
      KNOWLEDGE_EMBED: '/api/v1/admin/orchestration/knowledge/embed',
      KNOWLEDGE_EMBEDDING_STATUS: '/api/v1/admin/orchestration/knowledge/embedding-status',
      KNOWLEDGE_META_TAGS: '/api/v1/admin/orchestration/knowledge/meta-tags',
      WEBHOOKS: '/api/v1/admin/orchestration/webhooks',
      webhookById: (id: string): string => `/api/v1/admin/orchestration/webhooks/${id}`,
      COSTS: '/api/v1/admin/orchestration/costs',
      COSTS_SUMMARY: '/api/v1/admin/orchestration/costs/summary',
      COSTS_ALERTS: '/api/v1/admin/orchestration/costs/alerts',
      SETTINGS: '/api/v1/admin/orchestration/settings',
      EVALUATIONS: '/api/v1/admin/orchestration/evaluations',
      evaluationById: (id: string): string => `/api/v1/admin/orchestration/evaluations/${id}`,
      evaluationComplete: (id: string): string =>
        `/api/v1/admin/orchestration/evaluations/${id}/complete`,
      evaluationLogs: (id: string): string => `/api/v1/admin/orchestration/evaluations/${id}/logs`,
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
      MCP_AUDIT: '/api/v1/admin/orchestration/mcp/audit',
      MCP_SESSIONS: '/api/v1/admin/orchestration/mcp/sessions',
      mcpSessionById: (id: string): string => `/api/v1/admin/orchestration/mcp/sessions/${id}`,
    },
  },

  /** Public endpoints */
  PUBLIC: {
    HEALTH: '/api/health',
    CONTACT: '/api/v1/contact',
    CSP_REPORT: '/api/csp-report',
  },
} as const;
