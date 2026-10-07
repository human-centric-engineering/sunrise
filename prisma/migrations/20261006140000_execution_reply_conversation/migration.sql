-- t-770: the conversation a workflow run replies on, and the only one
-- send_message_to_channel lets it send to. Set by the inbound route, copied
-- by the rerun route; NULL for every other run.
ALTER TABLE "ai_workflow_execution" ADD COLUMN "replyConversationId" TEXT;

CREATE INDEX "ai_workflow_execution_replyConversationId_idx" ON "ai_workflow_execution"("replyConversationId");

ALTER TABLE "ai_workflow_execution" ADD CONSTRAINT "ai_workflow_execution_replyConversationId_fkey" FOREIGN KEY ("replyConversationId") REFERENCES "ai_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
