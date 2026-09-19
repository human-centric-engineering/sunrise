-- §107 t-705: every tenant-owned row knows its org.
--
-- One nullable `orgId` column + FK (ON DELETE CASCADE from org, so eraseOrg()
-- cascades without enumerating tables) + index on each of the 38 tenant-owned
-- tables that did not yet carry one (the four credential tables got theirs in
-- 20260917120000_org_identity). Every existing row is backfilled to the
-- install org — the one org every single-tenant install has. NOT NULL is a
-- later, staged migration (the AiKnowledgeDocument.slug precedent).
--
-- Hand-folded from `prisma migrate diff`: the three `DROP INDEX` statements
-- for the pgvector / tsvector indexes and the `DROP DEFAULT` on the GENERATED
-- searchVector column were removed — Prisma cannot model those objects and
-- re-emits their drops on every diff (see .context/database/prisma-unmodelled-objects.md).

-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_agent_capability" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_agent_knowledge_document" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_agent_knowledge_tag" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_agent_version" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_conversation" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_conversation_share" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_cost_log" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_dataset" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_dataset_case" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_evaluation_case_result" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_evaluation_log" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_evaluation_run" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_evaluation_session" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_event_hook" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_event_hook_delivery" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_experiment" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_experiment_variant" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_knowledge_base" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_knowledge_chunk" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_knowledge_document" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_knowledge_document_pending_change" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_knowledge_document_revision" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_knowledge_document_tag" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_message" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_message_embedding" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_outbound_message" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_user_memory" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_webhook_delivery" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_webhook_subscription" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_workflow" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_workflow_execution" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_workflow_execution_lease_event" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_workflow_running_step" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_workflow_schedule" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_workflow_step_dispatch" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_workflow_trigger" ADD COLUMN     "orgId" TEXT;

-- AlterTable
ALTER TABLE "ai_workflow_version" ADD COLUMN     "orgId" TEXT;

-- CreateIndex
CREATE INDEX "ai_agent_orgId_idx" ON "ai_agent"("orgId");

-- CreateIndex
CREATE INDEX "ai_agent_capability_orgId_idx" ON "ai_agent_capability"("orgId");

-- CreateIndex
CREATE INDEX "ai_agent_knowledge_document_orgId_idx" ON "ai_agent_knowledge_document"("orgId");

-- CreateIndex
CREATE INDEX "ai_agent_knowledge_tag_orgId_idx" ON "ai_agent_knowledge_tag"("orgId");

-- CreateIndex
CREATE INDEX "ai_agent_version_orgId_idx" ON "ai_agent_version"("orgId");

-- CreateIndex
CREATE INDEX "ai_conversation_orgId_idx" ON "ai_conversation"("orgId");

-- CreateIndex
CREATE INDEX "ai_conversation_share_orgId_idx" ON "ai_conversation_share"("orgId");

-- CreateIndex
CREATE INDEX "ai_cost_log_orgId_idx" ON "ai_cost_log"("orgId");

-- CreateIndex
CREATE INDEX "ai_dataset_orgId_idx" ON "ai_dataset"("orgId");

-- CreateIndex
CREATE INDEX "ai_dataset_case_orgId_idx" ON "ai_dataset_case"("orgId");

-- CreateIndex
CREATE INDEX "ai_evaluation_case_result_orgId_idx" ON "ai_evaluation_case_result"("orgId");

-- CreateIndex
CREATE INDEX "ai_evaluation_log_orgId_idx" ON "ai_evaluation_log"("orgId");

-- CreateIndex
CREATE INDEX "ai_evaluation_run_orgId_idx" ON "ai_evaluation_run"("orgId");

-- CreateIndex
CREATE INDEX "ai_evaluation_session_orgId_idx" ON "ai_evaluation_session"("orgId");

-- CreateIndex
CREATE INDEX "ai_event_hook_orgId_idx" ON "ai_event_hook"("orgId");

-- CreateIndex
CREATE INDEX "ai_event_hook_delivery_orgId_idx" ON "ai_event_hook_delivery"("orgId");

-- CreateIndex
CREATE INDEX "ai_experiment_orgId_idx" ON "ai_experiment"("orgId");

-- CreateIndex
CREATE INDEX "ai_experiment_variant_orgId_idx" ON "ai_experiment_variant"("orgId");

-- CreateIndex
CREATE INDEX "ai_knowledge_base_orgId_idx" ON "ai_knowledge_base"("orgId");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunk_orgId_idx" ON "ai_knowledge_chunk"("orgId");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_orgId_idx" ON "ai_knowledge_document"("orgId");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_pending_change_orgId_idx" ON "ai_knowledge_document_pending_change"("orgId");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_revision_orgId_idx" ON "ai_knowledge_document_revision"("orgId");

-- CreateIndex
CREATE INDEX "ai_knowledge_document_tag_orgId_idx" ON "ai_knowledge_document_tag"("orgId");

-- CreateIndex
CREATE INDEX "ai_message_orgId_idx" ON "ai_message"("orgId");

-- CreateIndex
CREATE INDEX "ai_message_embedding_orgId_idx" ON "ai_message_embedding"("orgId");

-- CreateIndex
CREATE INDEX "ai_outbound_message_orgId_idx" ON "ai_outbound_message"("orgId");

-- CreateIndex
CREATE INDEX "ai_user_memory_orgId_idx" ON "ai_user_memory"("orgId");

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_orgId_idx" ON "ai_webhook_delivery"("orgId");

-- CreateIndex
CREATE INDEX "ai_webhook_subscription_orgId_idx" ON "ai_webhook_subscription"("orgId");

-- CreateIndex
CREATE INDEX "ai_workflow_orgId_idx" ON "ai_workflow"("orgId");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_orgId_idx" ON "ai_workflow_execution"("orgId");

-- CreateIndex
CREATE INDEX "ai_workflow_execution_lease_event_orgId_idx" ON "ai_workflow_execution_lease_event"("orgId");

-- CreateIndex
CREATE INDEX "ai_workflow_running_step_orgId_idx" ON "ai_workflow_running_step"("orgId");

-- CreateIndex
CREATE INDEX "ai_workflow_schedule_orgId_idx" ON "ai_workflow_schedule"("orgId");

-- CreateIndex
CREATE INDEX "ai_workflow_step_dispatch_orgId_idx" ON "ai_workflow_step_dispatch"("orgId");

-- CreateIndex
CREATE INDEX "ai_workflow_trigger_orgId_idx" ON "ai_workflow_trigger"("orgId");

-- CreateIndex
CREATE INDEX "ai_workflow_version_orgId_idx" ON "ai_workflow_version"("orgId");

-- AddForeignKey
ALTER TABLE "ai_agent" ADD CONSTRAINT "ai_agent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_version" ADD CONSTRAINT "ai_agent_version_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_capability" ADD CONSTRAINT "ai_agent_capability_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_outbound_message" ADD CONSTRAINT "ai_outbound_message_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation_share" ADD CONSTRAINT "ai_conversation_share_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_message_embedding" ADD CONSTRAINT "ai_message_embedding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_event_hook" ADD CONSTRAINT "ai_event_hook_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_event_hook_delivery" ADD CONSTRAINT "ai_event_hook_delivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_user_memory" ADD CONSTRAINT "ai_user_memory_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_session" ADD CONSTRAINT "ai_evaluation_session_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_log" ADD CONSTRAINT "ai_evaluation_log_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_dataset" ADD CONSTRAINT "ai_dataset_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_dataset_case" ADD CONSTRAINT "ai_dataset_case_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_run" ADD CONSTRAINT "ai_evaluation_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_evaluation_case_result" ADD CONSTRAINT "ai_evaluation_case_result_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_base" ADD CONSTRAINT "ai_knowledge_base_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document" ADD CONSTRAINT "ai_knowledge_document_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document_revision" ADD CONSTRAINT "ai_knowledge_document_revision_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document_pending_change" ADD CONSTRAINT "ai_knowledge_document_pending_change_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_chunk" ADD CONSTRAINT "ai_knowledge_chunk_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_knowledge_document_tag" ADD CONSTRAINT "ai_knowledge_document_tag_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge_document" ADD CONSTRAINT "ai_agent_knowledge_document_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_knowledge_tag" ADD CONSTRAINT "ai_agent_knowledge_tag_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_webhook_subscription" ADD CONSTRAINT "ai_webhook_subscription_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_webhook_delivery" ADD CONSTRAINT "ai_webhook_delivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment" ADD CONSTRAINT "ai_experiment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_experiment_variant" ADD CONSTRAINT "ai_experiment_variant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL, not CASCADE: a cost row is a billing record; erasing an org detaches its spend rather than deleting it.
ALTER TABLE "ai_cost_log" ADD CONSTRAINT "ai_cost_log_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow" ADD CONSTRAINT "ai_workflow_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_version" ADD CONSTRAINT "ai_workflow_version_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_schedule" ADD CONSTRAINT "ai_workflow_schedule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_trigger" ADD CONSTRAINT "ai_workflow_trigger_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_execution" ADD CONSTRAINT "ai_workflow_execution_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_step_dispatch" ADD CONSTRAINT "ai_workflow_step_dispatch_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_running_step" ADD CONSTRAINT "ai_workflow_running_step_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_workflow_execution_lease_event" ADD CONSTRAINT "ai_workflow_execution_lease_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing row belongs to the install org (lib/tenancy/constants.ts INSTALL_ORG_ID).
UPDATE "ai_agent" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_agent_capability" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_agent_knowledge_document" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_agent_knowledge_tag" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_agent_version" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_conversation" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_conversation_share" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_cost_log" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_dataset" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_dataset_case" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_evaluation_case_result" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_evaluation_log" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_evaluation_run" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_evaluation_session" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_event_hook" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_event_hook_delivery" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_experiment" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_experiment_variant" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_knowledge_base" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_knowledge_chunk" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_knowledge_document" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_knowledge_document_pending_change" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_knowledge_document_revision" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_knowledge_document_tag" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_message" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_message_embedding" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_outbound_message" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_user_memory" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_webhook_delivery" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_webhook_subscription" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_workflow" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_workflow_execution" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_workflow_execution_lease_event" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_workflow_running_step" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_workflow_schedule" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_workflow_step_dispatch" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_workflow_trigger" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_workflow_version" SET "orgId" = 'install' WHERE "orgId" IS NULL;
