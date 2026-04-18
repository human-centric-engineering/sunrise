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

    CONSTRAINT "mcp_exposed_tool_pkey" PRIMARY KEY ("id")
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
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "rateLimitOverride" INTEGER,
    "createdBy" TEXT NOT NULL,
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

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_config_slug_key" ON "mcp_server_config"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_exposed_tool_capabilityId_key" ON "mcp_exposed_tool"("capabilityId");

-- CreateIndex
CREATE INDEX "mcp_exposed_tool_isEnabled_idx" ON "mcp_exposed_tool"("isEnabled");

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
CREATE INDEX "mcp_audit_log_apiKeyId_idx" ON "mcp_audit_log"("apiKeyId");

-- CreateIndex
CREATE INDEX "mcp_audit_log_createdAt_idx" ON "mcp_audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "mcp_audit_log_method_idx" ON "mcp_audit_log"("method");

-- CreateIndex
CREATE INDEX "mcp_audit_log_toolSlug_idx" ON "mcp_audit_log"("toolSlug");

-- AddForeignKey
ALTER TABLE "mcp_exposed_tool" ADD CONSTRAINT "mcp_exposed_tool_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "ai_capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_api_key" ADD CONSTRAINT "mcp_api_key_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_audit_log" ADD CONSTRAINT "mcp_audit_log_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "mcp_api_key"("id") ON DELETE SET NULL ON UPDATE CASCADE;
