-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "contact_submission" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "contact_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "feature_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "bio" TEXT,
    "phone" VARCHAR(20),
    "timezone" TEXT DEFAULT 'UTC',
    "location" VARCHAR(100),
    "preferences" JSONB DEFAULT '{}',

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_server_config" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL DEFAULT 'global',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "serverName" TEXT NOT NULL DEFAULT 'Sunrise MCP Server',
    "serverVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "maxSessionsPerKey" INTEGER NOT NULL DEFAULT 5,
    "globalRateLimit" INTEGER NOT NULL DEFAULT 60,
    "auditRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_server_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_exposed_tool" (
    "id" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "customName" TEXT,
    "customDescription" TEXT,
    "rateLimitPerKey" INTEGER,
    "requiresScope" TEXT,
    "customTitle" TEXT,
    "readOnlyHint" BOOLEAN,
    "destructiveHint" BOOLEAN,
    "idempotentHint" BOOLEAN,
    "openWorldHint" BOOLEAN,

    CONSTRAINT "mcp_exposed_tool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_exposed_prompt" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "argumentsSpec" JSONB NOT NULL,
    "completionsSpec" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_exposed_prompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_exposed_resource" (
    "id" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/json',
    "resourceType" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "handlerConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_exposed_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_api_key" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "scopedAgentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "rateLimitOverride" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_audit_log" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "method" TEXT NOT NULL,
    "toolSlug" TEXT,
    "resourceUri" TEXT,
    "requestParams" JSONB,
    "responseCode" TEXT NOT NULL,
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL,
    "clientIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "systemInstructions" TEXT NOT NULL,
    "systemInstructionsHistory" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "fallbackProviders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "providerConfig" JSONB,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "maxTokens" INTEGER NOT NULL DEFAULT 4096,
    "reasoningEffort" TEXT,
    "monthlyBudgetUsd" DOUBLE PRECISION,
    "maxCostPerTurnUsd" DOUBLE PRECISION,
    "metadata" JSONB,
    "knowledgeAccessMode" TEXT NOT NULL DEFAULT 'full',
    "knowledgeRetrievalMode" TEXT NOT NULL DEFAULT 'model',
    "knowledgeTriggerKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topicBoundaries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "persona" TEXT,
    "brandVoiceInstructions" TEXT,
    "guardrails" TEXT,
    "personaMode" TEXT NOT NULL DEFAULT 'override',
    "voiceMode" TEXT NOT NULL DEFAULT 'override',
    "guardrailsMode" TEXT NOT NULL DEFAULT 'override',
    "profileId" TEXT,
    "rateLimitRpm" INTEGER,
    "inputGuardMode" TEXT,
    "outputGuardMode" TEXT,
    "citationGuardMode" TEXT,
    "maxHistoryTokens" INTEGER,
    "maxHistoryMessages" INTEGER,
    "retentionDays" INTEGER,
    "visibility" TEXT NOT NULL DEFAULT 'internal',
    "widgetConfig" JSONB,
    "enableVoiceInput" BOOLEAN NOT NULL DEFAULT false,
    "enableImageInput" BOOLEAN NOT NULL DEFAULT false,
    "enableDocumentInput" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'chat',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),

    CONSTRAINT "ai_agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_profile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "persona" TEXT,
    "brandVoiceInstructions" TEXT,
    "guardrails" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agent_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_invite_token" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_invite_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_version" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeSummary" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_embed_token" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agent_embed_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_capability" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "functionDefinition" JSONB NOT NULL,
    "executionType" TEXT NOT NULL,
    "executionHandler" TEXT NOT NULL,
    "executionConfig" JSONB,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvalTimeoutMs" INTEGER,
    "rateLimit" INTEGER,
    "isIdempotent" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "quarantineState" TEXT NOT NULL DEFAULT 'active',
    "quarantineReason" TEXT,
    "quarantineUntil" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "ai_capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_capability" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "customConfig" JSONB,
    "customRateLimit" INTEGER,

    CONSTRAINT "ai_agent_capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "agentId" TEXT NOT NULL,
    "title" TEXT,
    "contextType" TEXT,
    "contextId" TEXT,
    "metadata" JSONB,
    "summary" TEXT,
    "summaryUpToMessageId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "channel" TEXT,
    "provider" TEXT,
    "fromAddress" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "smsOptedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_outbound_message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "transactionId" TEXT,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_outbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversation_share" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversation_share_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "capabilitySlug" TEXT,
    "toolCallId" TEXT,
    "rating" INTEGER,
    "ratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentVersionId" TEXT,
    "workflowExecutionId" TEXT,
    "workflowVersionId" TEXT,
    "modelId" TEXT,
    "providerSlug" TEXT,
    "provenance" JSONB,

    CONSTRAINT "ai_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_message_embedding" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "embeddingModel" TEXT,
    "embeddingProvider" TEXT,
    "embeddingDimension" INTEGER,

    CONSTRAINT "ai_message_embedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_event_hook" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "action" JSONB NOT NULL,
    "filter" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "secret" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_event_hook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_event_hook_delivery" (
    "id" TEXT NOT NULL,
    "hookId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "lastResponseCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_event_hook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_user_memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_user_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluation_session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "improvementSuggestions" JSONB,
    "metricSummary" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_evaluation_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluation_log" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "sequenceNumber" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "content" TEXT,
    "inputData" JSONB,
    "outputData" JSONB,
    "capabilitySlug" TEXT,
    "executionTimeMs" INTEGER,
    "tokenUsage" JSONB,
    "metadata" JSONB,
    "faithfulnessScore" DOUBLE PRECISION,
    "groundednessScore" DOUBLE PRECISION,
    "relevanceScore" DOUBLE PRECISION,
    "judgeReasoning" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_evaluation_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_dataset" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_dataset_case" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "expectedOutput" TEXT,
    "referenceCitations" JSONB,
    "metadata" JSONB,

    CONSTRAINT "ai_dataset_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluation_run" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "subjectKind" TEXT NOT NULL,
    "agentId" TEXT,
    "workflowId" TEXT,
    "datasetId" TEXT NOT NULL,
    "datasetContentHash" TEXT NOT NULL,
    "metricConfigs" JSONB NOT NULL,
    "judgeProvider" TEXT,
    "judgeModel" TEXT,
    "subjectOutputSelector" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" JSONB NOT NULL DEFAULT '{"casesTotal":0,"casesDone":0,"casesFailed":0}',
    "summary" JSONB,
    "gateConfig" JSONB,
    "totalCostUsd" DOUBLE PRECISION,
    "parentRunId" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_evaluation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluation_case_result" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "datasetCaseId" TEXT NOT NULL,
    "casePosition" INTEGER NOT NULL,
    "subjectOutput" TEXT NOT NULL,
    "subjectMetadata" JSONB,
    "metricScores" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_evaluation_case_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_base" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_knowledge_base_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_document" (
    "id" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'app',
    "sourceUrl" TEXT,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_knowledge_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_chunk" (
    "id" TEXT NOT NULL,
    "chunkKey" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    -- A1: searchVector is a GENERATED ALWAYS column populated by Postgres from
    -- (content || keywords). Source: 20260501172919_add_knowledge_chunk_search_vector.
    -- Prisma cannot model GENERATED expressions, so we emit the full DDL here.
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, '') || ' ' || coalesce(keywords, ''))) STORED,
    "chunkType" TEXT NOT NULL,
    "patternNumber" INTEGER,
    "patternName" TEXT,
    "section" TEXT,
    "keywords" TEXT,
    "estimatedTokens" INTEGER,
    "embeddingModel" TEXT,
    "embeddingProvider" TEXT,
    "embeddingDimension" INTEGER,
    "embeddedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "ai_knowledge_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_tag" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_document_tag" (
    "documentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_knowledge_document_tag_pkey" PRIMARY KEY ("documentId","tagId")
);

-- CreateTable
CREATE TABLE "ai_agent_knowledge_document" (
    "agentId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_knowledge_document_pkey" PRIMARY KEY ("agentId","documentId")
);

-- CreateTable
CREATE TABLE "ai_agent_knowledge_tag" (
    "agentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_knowledge_tag_pkey" PRIMARY KEY ("agentId","tagId")
);

-- CreateTable
CREATE TABLE "ai_webhook_subscription" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'webhook',
    "url" TEXT,
    "secret" TEXT,
    "emailAddress" TEXT,
    "events" TEXT[],
    -- B3: Prisma 7 NOT NULL omission on array @default — see B2 comment.
    "agentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- B4: Prisma 7 NOT NULL omission on array @default — see B2 comment.
    "workflowIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    -- B5: Prisma 7 NOT NULL omission on array @default — see B2 comment.
    "retryBackoffMs" INTEGER[] NOT NULL DEFAULT ARRAY[10000, 60000, 300000]::INTEGER[],
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_webhook_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_webhook_delivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "lastResponseCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_admin_audit_log" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "entityName" TEXT,
    "changes" JSONB,
    "metadata" JSONB,
    "clientIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_experiment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "agentId" TEXT NOT NULL,
    "datasetId" TEXT,
    "metricConfigs" JSONB,
    "pairwiseVerdict" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_experiment_variant" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "agentVersionId" TEXT,
    "evaluationSessionId" TEXT,
    "evaluationRunId" TEXT,
    "label" TEXT NOT NULL,
    "score" DOUBLE PRECISION,

    CONSTRAINT "ai_experiment_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_cost_log" (
    "id" TEXT NOT NULL,
    "agentId" TEXT,
    "conversationId" TEXT,
    "workflowExecutionId" TEXT,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "inputCostUsd" DOUBLE PRECISION NOT NULL,
    "outputCostUsd" DOUBLE PRECISION NOT NULL,
    "totalCostUsd" DOUBLE PRECISION NOT NULL,
    "isLocal" BOOLEAN NOT NULL DEFAULT false,
    "operation" TEXT NOT NULL,
    "metadata" JSONB,
    "traceId" TEXT,
    "spanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_cost_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_config" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEnvVar" TEXT,
    "isLocal" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "timeoutMs" INTEGER,
    "maxRetries" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_model" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "providerSlug" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY['chat']::TEXT[],
    "tierRole" TEXT NOT NULL,
    -- B2: Prisma 7 migrate diff omits NOT NULL on array columns with @default.
    -- Schema declares `String[] @default(["hosted"])` (non-nullable). Hand-fold.
    "deploymentProfiles" TEXT[] NOT NULL DEFAULT ARRAY['hosted']::TEXT[],
    "paramProfile" TEXT,
    "reasoningDepth" TEXT NOT NULL,
    "latency" TEXT NOT NULL,
    "costEfficiency" TEXT NOT NULL,
    "contextLength" TEXT NOT NULL,
    "toolUse" TEXT NOT NULL,
    "bestRole" TEXT NOT NULL,
    "dimensions" INTEGER,
    "schemaCompatible" BOOLEAN,
    "costPerMillionTokens" DOUBLE PRECISION,
    "hasFreeTier" BOOLEAN,
    "local" BOOLEAN NOT NULL DEFAULT false,
    "quality" TEXT,
    "strengths" TEXT,
    "setup" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_api_key" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['chat']::TEXT[],
    "rateLimitRpm" INTEGER,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_orchestration_settings" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL DEFAULT 'global',
    "defaultModels" JSONB NOT NULL,
    "activeEmbeddingModelId" TEXT,
    "globalMonthlyBudgetUsd" DOUBLE PRECISION,
    "defaultMaxCostPerExecutionUsd" DOUBLE PRECISION,
    "defaultMaxCostPerTurnUsd" DOUBLE PRECISION,
    "searchConfig" JSONB,
    "lastSeededAt" TIMESTAMP(3),
    "defaultApprovalTimeoutMs" INTEGER,
    "approvalDefaultAction" TEXT DEFAULT 'deny',
    "inputGuardMode" TEXT DEFAULT 'log_only',
    "outputGuardMode" TEXT DEFAULT 'log_only',
    "citationGuardMode" TEXT DEFAULT 'log_only',
    "webhookRetentionDays" INTEGER,
    "webhookDlqRetentionDays" INTEGER,
    "costLogRetentionDays" INTEGER,
    "auditLogRetentionDays" INTEGER,
    "executionRetentionDays" INTEGER,
    "evaluationRetentionDays" INTEGER,
    "maxConversationsPerUser" INTEGER,
    "maxMessagesPerConversation" INTEGER,
    "escalationConfig" JSONB,
    "embedAllowedOrigins" JSONB NOT NULL DEFAULT '[]',
    "voiceInputGloballyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "imageInputGloballyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "documentInputGloballyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "stuckExecutionThresholdMins" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_orchestration_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workflow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "draftDefinition" JSONB,
    "publishedVersionId" TEXT,
    "maxCostPerExecutionUsd" DOUBLE PRECISION,
    "patternsUsed" INTEGER[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "templateSource" TEXT,
    "metadata" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workflow_version" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeSummary" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workflow_schedule" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cronExpression" VARCHAR(100) NOT NULL,
    "inputTemplate" JSONB NOT NULL DEFAULT '{}',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_workflow_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workflow_trigger" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "channel" VARCHAR(40) NOT NULL,
    "name" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "signingSecret" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_workflow_trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workflow_execution" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "versionId" TEXT,
    "status" TEXT NOT NULL,
    "inputData" JSONB NOT NULL,
    "outputData" JSONB,
    "currentStep" TEXT,
    "executionTrace" JSONB NOT NULL,
    "totalTokensUsed" INTEGER NOT NULL DEFAULT 0,
    "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "budgetLimitUsd" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "triggerSource" VARCHAR(50),
    "triggerExternalId" TEXT,
    "dedupKey" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "supervisorVerdict" TEXT,
    "supervisorScore" DOUBLE PRECISION,
    "supervisorReport" JSONB,
    "supervisorReviewedAt" TIMESTAMP(3),
    "parentExecutionId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_workflow_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workflow_step_dispatch" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "turnIndex" INTEGER,
    "idempotencyKey" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_workflow_step_dispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workflow_running_step" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "stepType" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "turns" JSONB,

    CONSTRAINT "ai_workflow_running_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workflow_execution_lease_event" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "leaseToken" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_workflow_execution_lease_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seed_history" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL,

    CONSTRAINT "seed_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_erasure_receipt" (
    "id" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "subjectEmailHash" TEXT,
    "actorUserId" TEXT,
    "reason" TEXT NOT NULL,
    "erasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "data_erasure_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_submission_read_createdAt_idx" ON "contact_submission"("read", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_name_key" ON "feature_flag"("name");

-- CreateIndex
CREATE INDEX "feature_flag_name_idx" ON "feature_flag"("name");

-- CreateIndex
CREATE INDEX "user_role_idx" ON "user"("role");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "verification_expiresAt_idx" ON "verification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_config_slug_key" ON "mcp_server_config"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_exposed_tool_capabilityId_key" ON "mcp_exposed_tool"("capabilityId");

-- CreateIndex
CREATE INDEX "mcp_exposed_tool_isEnabled_idx" ON "mcp_exposed_tool"("isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_exposed_prompt_name_key" ON "mcp_exposed_prompt"("name");

-- CreateIndex
CREATE INDEX "mcp_exposed_prompt_isEnabled_idx" ON "mcp_exposed_prompt"("isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_exposed_resource_uri_key" ON "mcp_exposed_resource"("uri");

-- CreateIndex
CREATE INDEX "mcp_exposed_resource_isEnabled_idx" ON "mcp_exposed_resource"("isEnabled");

-- CreateIndex
CREATE INDEX "mcp_exposed_resource_resourceType_idx" ON "mcp_exposed_resource"("resourceType");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_api_key_keyHash_key" ON "mcp_api_key"("keyHash");

-- CreateIndex
CREATE INDEX "mcp_api_key_keyHash_idx" ON "mcp_api_key"("keyHash");

-- CreateIndex
CREATE INDEX "mcp_api_key_createdBy_idx" ON "mcp_api_key"("createdBy");

-- CreateIndex
CREATE INDEX "mcp_api_key_isActive_idx" ON "mcp_api_key"("isActive");

-- CreateIndex
CREATE INDEX "mcp_api_key_scopedAgentId_idx" ON "mcp_api_key"("scopedAgentId");

-- CreateIndex
CREATE INDEX "mcp_audit_log_apiKeyId_idx" ON "mcp_audit_log"("apiKeyId");

-- CreateIndex
CREATE INDEX "mcp_audit_log_createdAt_idx" ON "mcp_audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "mcp_audit_log_method_idx" ON "mcp_audit_log"("method");

-- CreateIndex
CREATE INDEX "mcp_audit_log_toolSlug_idx" ON "mcp_audit_log"("toolSlug");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_slug_key" ON "ai_agent"("slug");

-- CreateIndex
CREATE INDEX "ai_agent_createdBy_idx" ON "ai_agent"("createdBy");

-- CreateIndex
CREATE INDEX "ai_agent_provider_idx" ON "ai_agent"("provider");

-- CreateIndex
CREATE INDEX "ai_agent_isActive_visibility_idx" ON "ai_agent"("isActive", "visibility");

-- CreateIndex
CREATE INDEX "ai_agent_profileId_idx" ON "ai_agent"("profileId");

-- CreateIndex
CREATE INDEX "ai_agent_deletedAt_idx" ON "ai_agent"("deletedAt");

-- CreateIndex
CREATE INDEX "ai_agent_lastActiveAt_idx" ON "ai_agent"("lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_profile_slug_key" ON "ai_agent_profile"("slug");

-- CreateIndex
CREATE INDEX "ai_agent_profile_createdBy_idx" ON "ai_agent_profile"("createdBy");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_invite_token_token_key" ON "ai_agent_invite_token"("token");

-- CreateIndex
CREATE INDEX "ai_agent_invite_token_agentId_idx" ON "ai_agent_invite_token"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_version_agentId_version_key" ON "ai_agent_version"("agentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_embed_token_token_key" ON "ai_agent_embed_token"("token");

-- CreateIndex
CREATE INDEX "ai_agent_embed_token_agentId_idx" ON "ai_agent_embed_token"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_capability_slug_key" ON "ai_capability"("slug");

-- CreateIndex
CREATE INDEX "ai_capability_category_idx" ON "ai_capability"("category");

-- CreateIndex
CREATE INDEX "ai_capability_executionType_idx" ON "ai_capability"("executionType");

-- CreateIndex
CREATE INDEX "ai_capability_isActive_idx" ON "ai_capability"("isActive");

-- CreateIndex
CREATE INDEX "ai_capability_quarantineState_idx" ON "ai_capability"("quarantineState");

-- CreateIndex
CREATE INDEX "ai_agent_capability_agentId_idx" ON "ai_agent_capability"("agentId");

-- CreateIndex
CREATE INDEX "ai_agent_capability_capabilityId_idx" ON "ai_agent_capability"("capabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_capability_agentId_capabilityId_key" ON "ai_agent_capability"("agentId", "capabilityId");

-- CreateIndex
CREATE INDEX "ai_conversation_userId_idx" ON "ai_conversation"("userId");

-- CreateIndex
CREATE INDEX "ai_conversation_agentId_idx" ON "ai_conversation"("agentId");

-- CreateIndex
CREATE INDEX "ai_conversation_contextType_contextId_idx" ON "ai_conversation"("contextType", "contextId");

-- CreateIndex
CREATE INDEX "ai_conversation_isActive_idx" ON "ai_conversation"("isActive");

-- CreateIndex
CREATE INDEX "ai_conversation_updatedAt_idx" ON "ai_conversation"("updatedAt");

-- B1: Prisma 7 migrate diff ignores @@unique(name:) on the schema (issue:
-- baseline-generation only). Schema declares `name: "ai_conversation_inbound_key"`
-- but the generator emits the default-generated name. The original migration
-- (20260331132111_add_email_channel_to_ai_conversation_inbound_key) created
-- this as an ALTER TABLE ADD CONSTRAINT — emit the same shape here so
-- pg_constraint lookups and any ON CONFLICT ON CONSTRAINT usage match prod.
ALTER TABLE "ai_conversation"
    ADD CONSTRAINT "ai_conversation_inbound_key"
    UNIQUE ("agentId", "channel", "fromAddress");

-- CreateIndex
CREATE UNIQUE INDEX "ai_outbound_message_dedupKey_key" ON "ai_outbound_message"("dedupKey");

-- CreateIndex
CREATE INDEX "ai_outbound_message_conversationId_createdAt_idx" ON "ai_outbound_message"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_conversation_share_conversationId_key" ON "ai_conversation_share"("conversationId");

-- CreateIndex
CREATE INDEX "ai_conversation_share_expiresAt_idx" ON "ai_conversation_share"("expiresAt");

-- CreateIndex
CREATE INDEX "ai_message_conversationId_idx" ON "ai_message"("conversationId");

-- CreateIndex
CREATE INDEX "ai_message_conversationId_createdAt_idx" ON "ai_message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_message_role_idx" ON "ai_message"("role");

-- CreateIndex
CREATE INDEX "ai_message_createdAt_idx" ON "ai_message"("createdAt");

-- CreateIndex
CREATE INDEX "ai_message_rating_idx" ON "ai_message"("rating");

-- CreateIndex
CREATE INDEX "ai_message_agentVersionId_idx" ON "ai_message"("agentVersionId");

-- CreateIndex
CREATE INDEX "ai_message_workflowExecutionId_idx" ON "ai_message"("workflowExecutionId");

-- CreateIndex
CREATE INDEX "ai_message_modelId_idx" ON "ai_message"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_message_embedding_messageId_key" ON "ai_message_embedding"("messageId");

-- CreateIndex
CREATE INDEX "ai_message_embedding_messageId_idx" ON "ai_message_embedding"("messageId");

-- CreateIndex
CREATE INDEX "ai_event_hook_eventType_idx" ON "ai_event_hook"("eventType");

-- CreateIndex
CREATE INDEX "ai_event_hook_isEnabled_idx" ON "ai_event_hook"("isEnabled");

-- CreateIndex
CREATE INDEX "ai_event_hook_delivery_hookId_idx" ON "ai_event_hook_delivery"("hookId");

-- CreateIndex
CREATE INDEX "ai_event_hook_delivery_status_idx" ON "ai_event_hook_delivery"("status");

-- CreateIndex
CREATE INDEX "ai_event_hook_delivery_nextRetryAt_idx" ON "ai_event_hook_delivery"("nextRetryAt");

-- CreateIndex
CREATE INDEX "ai_user_memory_userId_agentId_idx" ON "ai_user_memory"("userId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_user_memory_userId_agentId_key_key" ON "ai_user_memory"("userId", "agentId", "key");

-- CreateIndex
CREATE INDEX "ai_evaluation_session_userId_idx" ON "ai_evaluation_session"("userId");

-- CreateIndex
CREATE INDEX "ai_evaluation_session_agentId_idx" ON "ai_evaluation_session"("agentId");

-- CreateIndex
CREATE INDEX "ai_evaluation_session_status_idx" ON "ai_evaluation_session"("status");

-- CreateIndex
CREATE INDEX "ai_evaluation_log_sessionId_idx" ON "ai_evaluation_log"("sessionId");

-- CreateIndex
CREATE INDEX "ai_evaluation_log_messageId_idx" ON "ai_evaluation_log"("messageId");

-- CreateIndex
CREATE INDEX "ai_evaluation_log_eventType_idx" ON "ai_evaluation_log"("eventType");

-- CreateIndex
CREATE INDEX "ai_dataset_userId_updatedAt_idx" ON "ai_dataset"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_dataset_case_datasetId_idx" ON "ai_dataset_case"("datasetId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_dataset_case_datasetId_position_key" ON "ai_dataset_case"("datasetId", "position");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_userId_updatedAt_idx" ON "ai_evaluation_run"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_status_lockedAt_idx" ON "ai_evaluation_run"("status", "lockedAt");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_datasetId_idx" ON "ai_evaluation_run"("datasetId");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_agentId_idx" ON "ai_evaluation_run"("agentId");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_workflowId_idx" ON "ai_evaluation_run"("workflowId");

-- CreateIndex
CREATE INDEX "ai_evaluation_case_result_runId_idx" ON "ai_evaluation_case_result"("runId");

-- CreateIndex
CREATE INDEX "ai_evaluation_case_result_datasetCaseId_idx" ON "ai_evaluation_case_result"("datasetCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_evaluation_case_result_runId_casePosition_key" ON "ai_evaluation_case_result"("runId", "casePosition");

-- CreateIndex
CREATE UNIQUE INDEX "ai_knowledge_base_slug_key" ON "ai_knowledge_base"("slug");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_uploadedBy_idx" ON "ai_knowledge_document"("uploadedBy");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_status_idx" ON "ai_knowledge_document"("status");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_scope_idx" ON "ai_knowledge_document"("scope");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_fileHash_idx" ON "ai_knowledge_document"("fileHash");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_knowledgeBaseId_idx" ON "ai_knowledge_document"("knowledgeBaseId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_knowledge_chunk_chunkKey_key" ON "ai_knowledge_chunk"("chunkKey");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunk_documentId_idx" ON "ai_knowledge_chunk"("documentId");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunk_chunkType_idx" ON "ai_knowledge_chunk"("chunkType");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunk_patternNumber_idx" ON "ai_knowledge_chunk"("patternNumber");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_tag_slug_key" ON "knowledge_tag"("slug");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_tag_tagId_idx" ON "ai_knowledge_document_tag"("tagId");

-- CreateIndex
CREATE INDEX "ai_agent_knowledge_document_documentId_idx" ON "ai_agent_knowledge_document"("documentId");

-- CreateIndex
CREATE INDEX "ai_agent_knowledge_tag_tagId_idx" ON "ai_agent_knowledge_tag"("tagId");

-- CreateIndex
CREATE INDEX "ai_webhook_subscription_isActive_idx" ON "ai_webhook_subscription"("isActive");

-- CreateIndex
CREATE INDEX "ai_webhook_subscription_createdBy_idx" ON "ai_webhook_subscription"("createdBy");

-- CreateIndex
CREATE INDEX "ai_webhook_subscription_channel_idx" ON "ai_webhook_subscription"("channel");

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_subscriptionId_idx" ON "ai_webhook_delivery"("subscriptionId");

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_status_idx" ON "ai_webhook_delivery"("status");

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_nextRetryAt_idx" ON "ai_webhook_delivery"("nextRetryAt");

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_userId_idx" ON "ai_admin_audit_log"("userId");

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_action_idx" ON "ai_admin_audit_log"("action");

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_entityType_entityId_idx" ON "ai_admin_audit_log"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_createdAt_idx" ON "ai_admin_audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "ai_experiment_agentId_idx" ON "ai_experiment"("agentId");

-- CreateIndex
CREATE INDEX "ai_experiment_status_idx" ON "ai_experiment"("status");

-- CreateIndex
CREATE INDEX "ai_experiment_datasetId_idx" ON "ai_experiment"("datasetId");

-- CreateIndex
CREATE INDEX "ai_experiment_variant_experimentId_idx" ON "ai_experiment_variant"("experimentId");

-- CreateIndex
CREATE INDEX "ai_experiment_variant_evaluationSessionId_idx" ON "ai_experiment_variant"("evaluationSessionId");

-- CreateIndex
CREATE INDEX "ai_experiment_variant_evaluationRunId_idx" ON "ai_experiment_variant"("evaluationRunId");

-- CreateIndex
CREATE INDEX "ai_cost_log_agentId_idx" ON "ai_cost_log"("agentId");

-- CreateIndex
CREATE INDEX "ai_cost_log_conversationId_idx" ON "ai_cost_log"("conversationId");

-- CreateIndex
CREATE INDEX "ai_cost_log_workflowExecutionId_idx" ON "ai_cost_log"("workflowExecutionId");

-- CreateIndex
CREATE INDEX "ai_cost_log_provider_idx" ON "ai_cost_log"("provider");

-- CreateIndex
CREATE INDEX "ai_cost_log_operation_idx" ON "ai_cost_log"("operation");

-- CreateIndex
CREATE INDEX "ai_cost_log_createdAt_idx" ON "ai_cost_log"("createdAt");

-- CreateIndex
CREATE INDEX "ai_cost_log_agentId_createdAt_idx" ON "ai_cost_log"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_cost_log_traceId_idx" ON "ai_cost_log"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_config_name_key" ON "ai_provider_config"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_config_slug_key" ON "ai_provider_config"("slug");

-- CreateIndex
CREATE INDEX "ai_provider_config_createdBy_idx" ON "ai_provider_config"("createdBy");

-- CreateIndex
CREATE INDEX "ai_provider_config_providerType_idx" ON "ai_provider_config"("providerType");

-- CreateIndex
CREATE INDEX "ai_provider_config_isActive_idx" ON "ai_provider_config"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_model_slug_key" ON "ai_provider_model"("slug");

-- CreateIndex
CREATE INDEX "ai_provider_model_createdBy_idx" ON "ai_provider_model"("createdBy");

-- CreateIndex
CREATE INDEX "ai_provider_model_isActive_idx" ON "ai_provider_model"("isActive");

-- CreateIndex
CREATE INDEX "ai_provider_model_tierRole_idx" ON "ai_provider_model"("tierRole");

-- CreateIndex
CREATE INDEX "ai_provider_model_providerSlug_idx" ON "ai_provider_model"("providerSlug");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_model_providerSlug_modelId_key" ON "ai_provider_model"("providerSlug", "modelId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_api_key_keyHash_key" ON "ai_api_key"("keyHash");

-- CreateIndex
CREATE INDEX "ai_api_key_userId_idx" ON "ai_api_key"("userId");

-- CreateIndex
CREATE INDEX "ai_api_key_keyHash_idx" ON "ai_api_key"("keyHash");

-- CreateIndex
CREATE UNIQUE INDEX "ai_orchestration_settings_slug_key" ON "ai_orchestration_settings"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ai_workflow_slug_key" ON "ai_workflow"("slug");

-- CreateIndex
CREATE INDEX "ai_workflow_createdBy_idx" ON "ai_workflow"("createdBy");

-- CreateIndex
CREATE INDEX "ai_workflow_isActive_idx" ON "ai_workflow"("isActive");

-- CreateIndex
CREATE INDEX "ai_workflow_isTemplate_idx" ON "ai_workflow"("isTemplate");

-- CreateIndex
CREATE INDEX "ai_workflow_isSystem_idx" ON "ai_workflow"("isSystem");

-- CreateIndex
CREATE INDEX "ai_workflow_slug_isActive_idx" ON "ai_workflow"("slug", "isActive");

-- CreateIndex
CREATE INDEX "ai_workflow_publishedVersionId_idx" ON "ai_workflow"("publishedVersionId");

-- CreateIndex
CREATE INDEX "ai_workflow_version_workflowId_idx" ON "ai_workflow_version"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_workflow_version_workflowId_version_key" ON "ai_workflow_version"("workflowId", "version");

-- CreateIndex
CREATE INDEX "ai_workflow_schedule_workflowId_idx" ON "ai_workflow_schedule"("workflowId");

-- CreateIndex
CREATE INDEX "ai_workflow_schedule_isEnabled_nextRunAt_idx" ON "ai_workflow_schedule"("isEnabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "ai_workflow_trigger_workflowId_idx" ON "ai_workflow_trigger"("workflowId");

-- CreateIndex
CREATE INDEX "ai_workflow_trigger_channel_isEnabled_idx" ON "ai_workflow_trigger"("channel", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "ai_workflow_trigger_channel_workflowId_key" ON "ai_workflow_trigger"("channel", "workflowId");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_workflowId_idx" ON "ai_workflow_execution"("workflowId");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_versionId_idx" ON "ai_workflow_execution"("versionId");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_userId_idx" ON "ai_workflow_execution"("userId");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_status_idx" ON "ai_workflow_execution"("status");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_createdAt_idx" ON "ai_workflow_execution"("createdAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_status_startedAt_idx" ON "ai_workflow_execution"("status", "startedAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_status_createdAt_idx" ON "ai_workflow_execution"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_status_updatedAt_idx" ON "ai_workflow_execution"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_status_leaseExpiresAt_idx" ON "ai_workflow_execution"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_userId_status_createdAt_idx" ON "ai_workflow_execution"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_parentExecutionId_idx" ON "ai_workflow_execution"("parentExecutionId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_workflow_execution_dedup_key" ON "ai_workflow_execution"("dedupKey");

-- CreateIndex
CREATE UNIQUE INDEX "ai_workflow_step_dispatch_idempotencyKey_key" ON "ai_workflow_step_dispatch"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ai_workflow_step_dispatch_executionId_stepId_idx" ON "ai_workflow_step_dispatch"("executionId", "stepId");

-- CreateIndex
CREATE INDEX "ai_workflow_step_dispatch_createdAt_idx" ON "ai_workflow_step_dispatch"("createdAt");

-- CreateIndex
CREATE INDEX "ai_workflow_running_step_executionId_idx" ON "ai_workflow_running_step"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_workflow_running_step_executionId_stepId_key" ON "ai_workflow_running_step"("executionId", "stepId");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_lease_event_executionId_createdAt_idx" ON "ai_workflow_execution_lease_event"("executionId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_lease_event_createdAt_idx" ON "ai_workflow_execution_lease_event"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "seed_history_name_key" ON "seed_history"("name");

-- CreateIndex
CREATE INDEX "data_erasure_receipt_subjectUserId_idx" ON "data_erasure_receipt"("subjectUserId");

-- CreateIndex
CREATE INDEX "data_erasure_receipt_erasedAt_idx" ON "data_erasure_receipt"("erasedAt");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_exposed_tool" ADD CONSTRAINT "mcp_exposed_tool_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "ai_capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_exposed_prompt" ADD CONSTRAINT "mcp_exposed_prompt_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_api_key" ADD CONSTRAINT "mcp_api_key_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_api_key" ADD CONSTRAINT "mcp_api_key_scopedAgentId_fkey" FOREIGN KEY ("scopedAgentId") REFERENCES "ai_agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_audit_log" ADD CONSTRAINT "mcp_audit_log_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "mcp_api_key"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent" ADD CONSTRAINT "ai_agent_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent" ADD CONSTRAINT "ai_agent_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ai_agent_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_profile" ADD CONSTRAINT "ai_agent_profile_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_invite_token" ADD CONSTRAINT "ai_agent_invite_token_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_invite_token" ADD CONSTRAINT "ai_agent_invite_token_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_version" ADD CONSTRAINT "ai_agent_version_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_version" ADD CONSTRAINT "ai_agent_version_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_embed_token" ADD CONSTRAINT "ai_agent_embed_token_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_embed_token" ADD CONSTRAINT "ai_agent_embed_token_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_capability" ADD CONSTRAINT "ai_agent_capability_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_capability" ADD CONSTRAINT "ai_agent_capability_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "ai_capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_outbound_message" ADD CONSTRAINT "ai_outbound_message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation_share" ADD CONSTRAINT "ai_conversation_share_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_message_embedding" ADD CONSTRAINT "ai_message_embedding_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ai_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_event_hook" ADD CONSTRAINT "ai_event_hook_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_event_hook_delivery" ADD CONSTRAINT "ai_event_hook_delivery_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "ai_event_hook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_user_memory" ADD CONSTRAINT "ai_user_memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_user_memory" ADD CONSTRAINT "ai_user_memory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_session" ADD CONSTRAINT "ai_evaluation_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_session" ADD CONSTRAINT "ai_evaluation_session_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_log" ADD CONSTRAINT "ai_evaluation_log_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_evaluation_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_log" ADD CONSTRAINT "ai_evaluation_log_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ai_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_dataset" ADD CONSTRAINT "ai_dataset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_dataset_case" ADD CONSTRAINT "ai_dataset_case_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "ai_dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "ai_dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "ai_evaluation_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_case_result" ADD CONSTRAINT "ai_evaluation_case_result_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_evaluation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_case_result" ADD CONSTRAINT "ai_evaluation_case_result_datasetCaseId_fkey" FOREIGN KEY ("datasetCaseId") REFERENCES "ai_dataset_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document" ADD CONSTRAINT "ai_knowledge_document_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "ai_knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document" ADD CONSTRAINT "ai_knowledge_document_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_chunk" ADD CONSTRAINT "ai_knowledge_chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ai_knowledge_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document_tag" ADD CONSTRAINT "ai_knowledge_document_tag_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ai_knowledge_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document_tag" ADD CONSTRAINT "ai_knowledge_document_tag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "knowledge_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge_document" ADD CONSTRAINT "ai_agent_knowledge_document_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge_document" ADD CONSTRAINT "ai_agent_knowledge_document_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ai_knowledge_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge_tag" ADD CONSTRAINT "ai_agent_knowledge_tag_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge_tag" ADD CONSTRAINT "ai_agent_knowledge_tag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "knowledge_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_webhook_subscription" ADD CONSTRAINT "ai_webhook_subscription_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_webhook_delivery" ADD CONSTRAINT "ai_webhook_delivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "ai_webhook_subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_admin_audit_log" ADD CONSTRAINT "ai_admin_audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment" ADD CONSTRAINT "ai_experiment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment" ADD CONSTRAINT "ai_experiment_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "ai_dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment" ADD CONSTRAINT "ai_experiment_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment_variant" ADD CONSTRAINT "ai_experiment_variant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "ai_experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment_variant" ADD CONSTRAINT "ai_experiment_variant_evaluationSessionId_fkey" FOREIGN KEY ("evaluationSessionId") REFERENCES "ai_evaluation_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment_variant" ADD CONSTRAINT "ai_experiment_variant_evaluationRunId_fkey" FOREIGN KEY ("evaluationRunId") REFERENCES "ai_evaluation_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_cost_log" ADD CONSTRAINT "ai_cost_log_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_cost_log" ADD CONSTRAINT "ai_cost_log_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_cost_log" ADD CONSTRAINT "ai_cost_log_workflowExecutionId_fkey" FOREIGN KEY ("workflowExecutionId") REFERENCES "ai_workflow_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_provider_config" ADD CONSTRAINT "ai_provider_config_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_provider_model" ADD CONSTRAINT "ai_provider_model_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_api_key" ADD CONSTRAINT "ai_api_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_orchestration_settings" ADD CONSTRAINT "ai_orchestration_settings_activeEmbeddingModelId_fkey" FOREIGN KEY ("activeEmbeddingModelId") REFERENCES "ai_provider_model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow" ADD CONSTRAINT "ai_workflow_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow" ADD CONSTRAINT "ai_workflow_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "ai_workflow_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_version" ADD CONSTRAINT "ai_workflow_version_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_version" ADD CONSTRAINT "ai_workflow_version_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_schedule" ADD CONSTRAINT "ai_workflow_schedule_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_schedule" ADD CONSTRAINT "ai_workflow_schedule_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_trigger" ADD CONSTRAINT "ai_workflow_trigger_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_trigger" ADD CONSTRAINT "ai_workflow_trigger_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_execution" ADD CONSTRAINT "ai_workflow_execution_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_execution" ADD CONSTRAINT "ai_workflow_execution_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ai_workflow_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_execution" ADD CONSTRAINT "ai_workflow_execution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_execution" ADD CONSTRAINT "ai_workflow_execution_parentExecutionId_fkey" FOREIGN KEY ("parentExecutionId") REFERENCES "ai_workflow_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_step_dispatch" ADD CONSTRAINT "ai_workflow_step_dispatch_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ai_workflow_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_running_step" ADD CONSTRAINT "ai_workflow_running_step_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ai_workflow_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_execution_lease_event" ADD CONSTRAINT "ai_workflow_execution_lease_event_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ai_workflow_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =========================================================================
-- Group A hand-folds: intentional drift that Prisma cannot model.
-- Each object is documented in a "PRISMA-SCHEMA DRIFT WARNING" block on the
-- corresponding model in prisma/schema/*.prisma.
-- =========================================================================

-- A2: GIN index over the GENERATED searchVector column on ai_knowledge_chunk.
-- Source: 20260501172919_add_knowledge_chunk_search_vector.
CREATE INDEX "idx_ai_knowledge_chunk_search_vector"
    ON "ai_knowledge_chunk" USING GIN ("searchVector");

-- A3: HNSW vector-similarity index for knowledge embeddings.
-- Source: 20260529120000_restore_knowledge_embedding_hnsw_index
-- (originally added by 20260409214649_add_hnsw_vector_index; accidentally
-- dropped by 20260411133126_add_orchestration_settings and silently absent
-- for 7 weeks until the May 29 restore — see the restore migration for the
-- full incident write-up).
CREATE INDEX "idx_knowledge_embedding"
    ON "ai_knowledge_chunk" USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- A4: HNSW vector-similarity index for message embeddings.
-- Source: 20260514151915_flexible_embedding_models_and_kb_grouping
-- (supersedes 20260420063847_add_message_embedding_hnsw_index, which was
-- dropped+recreated by the May 14 migration after the column was resized).
CREATE INDEX "idx_message_embedding"
    ON "ai_message_embedding" USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- A5: Partial unique index enforcing one "ready" document per fileHash —
-- earlier failed/processing rows with the same hash are allowed (so we can
-- retry without manual cleanup). The plain @@index([fileHash]) declared on
-- the model coexists with this and supports lookup by hash regardless of
-- status. Source: 20260410120000_dedupe_ready_knowledge_documents.
CREATE UNIQUE INDEX "idx_knowledge_doc_file_hash_ready"
    ON "ai_knowledge_document" ("fileHash")
    WHERE status = 'ready';

-- A6: CHECK constraint enforcing that lease token and expiry are co-set or
-- co-cleared, AND that a non-null token is non-empty. Half-set rows would
-- be permanently invisible to the orphan sweep (filters on leaseExpiresAt
-- < now); an empty-string token would satisfy the original co-set check
-- but still leak through code paths that early-return on `if (!leaseToken)`.
-- See schema warning block on AiWorkflowExecution.
-- Source: 20260508114325_add_lease_pair_check, tightened to also reject
-- empty-string tokens by the 2026-05-29 post-squash hardening fold.
ALTER TABLE "ai_workflow_execution"
    ADD CONSTRAINT "ai_workflow_execution_lease_pair_coherent"
    CHECK (
        (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))
        AND ("leaseToken" IS NULL OR length("leaseToken") > 0)
    );

-- A7: partial unique index enforcing that at most one ai_knowledge_base row
-- carries isDefault=true. The "default knowledge base" id is a runtime
-- contract referenced by getOrCreateDefaultKnowledgeBase() and by every
-- upload path; a second isDefault=true row would silently divert uploads.
-- See schema warning block on AiKnowledgeBase.
-- Source: 2026-05-29 post-squash hardening fold.
CREATE UNIQUE INDEX "idx_ai_knowledge_base_single_default"
    ON "ai_knowledge_base" ("isDefault")
    WHERE "isDefault" = true;

-- A8: CHECK constraint pinning ai_knowledge_document.status to the four
-- documented values. Prisma models the field as a free-form String; this
-- catches typos / casing drift (e.g. 'Ready' vs 'ready') from raw-SQL or
-- direct-DB writes before they corrupt the upload state machine.
-- See schema warning block on AiKnowledgeDocument.
-- Source: 2026-05-29 post-squash hardening fold.
ALTER TABLE "ai_knowledge_document"
    ADD CONSTRAINT "ai_knowledge_document_status_lowercase"
    CHECK ("status" IN ('processing', 'ready', 'failed', 'pending_review'));
