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

-- CreateIndex
CREATE INDEX "ai_user_memory_userId_agentId_idx" ON "ai_user_memory"("userId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_user_memory_userId_agentId_key_key" ON "ai_user_memory"("userId", "agentId", "key");

-- AddForeignKey
ALTER TABLE "ai_user_memory" ADD CONSTRAINT "ai_user_memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_user_memory" ADD CONSTRAINT "ai_user_memory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
