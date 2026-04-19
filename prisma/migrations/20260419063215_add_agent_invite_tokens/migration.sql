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
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_invite_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_invite_token_token_key" ON "ai_agent_invite_token"("token");

-- CreateIndex
CREATE INDEX "ai_agent_invite_token_agentId_idx" ON "ai_agent_invite_token"("agentId");

-- CreateIndex
CREATE INDEX "ai_agent_invite_token_token_idx" ON "ai_agent_invite_token"("token");

-- AddForeignKey
ALTER TABLE "ai_agent_invite_token" ADD CONSTRAINT "ai_agent_invite_token_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_invite_token" ADD CONSTRAINT "ai_agent_invite_token_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
