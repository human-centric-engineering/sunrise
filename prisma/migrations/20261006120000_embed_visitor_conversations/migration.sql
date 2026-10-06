-- #705 t-765: an anonymous embed-widget visitor owns their conversations through
-- this column, not through "userId" (a visitor is not a "user" row).
ALTER TABLE "ai_conversation" ADD COLUMN "embedVisitorId" TEXT;

CREATE INDEX "ai_conversation_embedVisitorId_agentId_idx" ON "ai_conversation"("embedVisitorId", "agentId");
