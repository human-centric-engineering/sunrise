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
    "providerConfig" JSONB,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "maxTokens" INTEGER NOT NULL DEFAULT 4096,
    "monthlyBudgetUsd" DOUBLE PRECISION,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agent_pkey" PRIMARY KEY ("id")
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
    "rateLimit" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
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
CREATE TABLE "ai_workflow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "workflowDefinition" JSONB NOT NULL,
    "patternsUsed" INTEGER[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_workflow_execution" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
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
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_workflow_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT,
    "contextType" TEXT,
    "contextId" TEXT,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversation_pkey" PRIMARY KEY ("id")
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_document" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "uploadedBy" TEXT NOT NULL,
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
    "chunkType" TEXT NOT NULL,
    "patternNumber" INTEGER,
    "patternName" TEXT,
    "category" TEXT,
    "section" TEXT,
    "keywords" TEXT,
    "estimatedTokens" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "ai_knowledge_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluation_session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "improvementSuggestions" JSONB,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_evaluation_log_pkey" PRIMARY KEY ("id")
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
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_slug_key" ON "ai_agent"("slug");

-- CreateIndex
CREATE INDEX "ai_agent_createdBy_idx" ON "ai_agent"("createdBy");

-- CreateIndex
CREATE INDEX "ai_agent_provider_idx" ON "ai_agent"("provider");

-- CreateIndex
CREATE INDEX "ai_agent_isActive_idx" ON "ai_agent"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ai_capability_slug_key" ON "ai_capability"("slug");

-- CreateIndex
CREATE INDEX "ai_capability_category_idx" ON "ai_capability"("category");

-- CreateIndex
CREATE INDEX "ai_capability_executionType_idx" ON "ai_capability"("executionType");

-- CreateIndex
CREATE INDEX "ai_capability_isActive_idx" ON "ai_capability"("isActive");

-- CreateIndex
CREATE INDEX "ai_agent_capability_agentId_idx" ON "ai_agent_capability"("agentId");

-- CreateIndex
CREATE INDEX "ai_agent_capability_capabilityId_idx" ON "ai_agent_capability"("capabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_capability_agentId_capabilityId_key" ON "ai_agent_capability"("agentId", "capabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_workflow_slug_key" ON "ai_workflow"("slug");

-- CreateIndex
CREATE INDEX "ai_workflow_createdBy_idx" ON "ai_workflow"("createdBy");

-- CreateIndex
CREATE INDEX "ai_workflow_isActive_idx" ON "ai_workflow"("isActive");

-- CreateIndex
CREATE INDEX "ai_workflow_isTemplate_idx" ON "ai_workflow"("isTemplate");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_workflowId_idx" ON "ai_workflow_execution"("workflowId");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_userId_idx" ON "ai_workflow_execution"("userId");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_status_idx" ON "ai_workflow_execution"("status");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_createdAt_idx" ON "ai_workflow_execution"("createdAt");

-- CreateIndex
CREATE INDEX "ai_conversation_userId_idx" ON "ai_conversation"("userId");

-- CreateIndex
CREATE INDEX "ai_conversation_agentId_idx" ON "ai_conversation"("agentId");

-- CreateIndex
CREATE INDEX "ai_conversation_contextType_contextId_idx" ON "ai_conversation"("contextType", "contextId");

-- CreateIndex
CREATE INDEX "ai_conversation_isActive_idx" ON "ai_conversation"("isActive");

-- CreateIndex
CREATE INDEX "ai_message_conversationId_idx" ON "ai_message"("conversationId");

-- CreateIndex
CREATE INDEX "ai_message_role_idx" ON "ai_message"("role");

-- CreateIndex
CREATE INDEX "ai_message_createdAt_idx" ON "ai_message"("createdAt");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_uploadedBy_idx" ON "ai_knowledge_document"("uploadedBy");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_status_idx" ON "ai_knowledge_document"("status");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_fileHash_idx" ON "ai_knowledge_document"("fileHash");

-- CreateIndex
CREATE UNIQUE INDEX "ai_knowledge_chunk_chunkKey_key" ON "ai_knowledge_chunk"("chunkKey");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunk_documentId_idx" ON "ai_knowledge_chunk"("documentId");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunk_chunkType_idx" ON "ai_knowledge_chunk"("chunkType");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunk_patternNumber_idx" ON "ai_knowledge_chunk"("patternNumber");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunk_category_idx" ON "ai_knowledge_chunk"("category");

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
CREATE UNIQUE INDEX "ai_provider_config_name_key" ON "ai_provider_config"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_config_slug_key" ON "ai_provider_config"("slug");

-- CreateIndex
CREATE INDEX "ai_provider_config_createdBy_idx" ON "ai_provider_config"("createdBy");

-- CreateIndex
CREATE INDEX "ai_provider_config_providerType_idx" ON "ai_provider_config"("providerType");

-- CreateIndex
CREATE INDEX "ai_provider_config_isActive_idx" ON "ai_provider_config"("isActive");

-- AddForeignKey
ALTER TABLE "ai_agent" ADD CONSTRAINT "ai_agent_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_capability" ADD CONSTRAINT "ai_agent_capability_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_capability" ADD CONSTRAINT "ai_agent_capability_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "ai_capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow" ADD CONSTRAINT "ai_workflow_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_execution" ADD CONSTRAINT "ai_workflow_execution_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_execution" ADD CONSTRAINT "ai_workflow_execution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document" ADD CONSTRAINT "ai_knowledge_document_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_chunk" ADD CONSTRAINT "ai_knowledge_chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ai_knowledge_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_session" ADD CONSTRAINT "ai_evaluation_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_session" ADD CONSTRAINT "ai_evaluation_session_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_log" ADD CONSTRAINT "ai_evaluation_log_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_evaluation_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_log" ADD CONSTRAINT "ai_evaluation_log_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ai_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_cost_log" ADD CONSTRAINT "ai_cost_log_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_cost_log" ADD CONSTRAINT "ai_cost_log_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_cost_log" ADD CONSTRAINT "ai_cost_log_workflowExecutionId_fkey" FOREIGN KEY ("workflowExecutionId") REFERENCES "ai_workflow_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_provider_config" ADD CONSTRAINT "ai_provider_config_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
