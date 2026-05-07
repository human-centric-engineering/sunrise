-- Inbound triggers: third-party systems (Slack, Postmark, generic-HMAC) that
-- start workflow executions via POST /api/v1/inbound/:channel/:slug.
-- See .context/orchestration/inbound-triggers.md.

-- AlterTable: trigger attribution + dedup columns. Strict additive change —
-- historical rows have NULL for all three, which correctly reflects that they
-- were not driven by an inbound trigger. Postgres treats NULL as distinct, so
-- the dedup unique below never blocks non-inbound rows.
--
-- Why three columns: triggerSource + triggerExternalId carry vendor-supplied
-- attribution for audit/observability; dedupKey carries the route-computed
-- collision key. They differ for shared-secret channels (Slack/Postmark) where
-- replay protection must be channel-global, not workflow-local — see route.ts
-- comments and `.context/orchestration/inbound-triggers.md` for the threat model.
ALTER TABLE "ai_workflow_execution"
  ADD COLUMN "triggerSource" VARCHAR(50),
  ADD COLUMN "triggerExternalId" TEXT,
  ADD COLUMN "dedupKey" TEXT;

-- Replay-dedup unique. Route computes `dedupKey` per-channel:
--   slack/postmark (shared signing secret across workflows): `<channel>:<externalId>`
--   hmac (per-trigger secret):                                `hmac:<workflowId>:<externalId>`
-- Slack retries / Postmark redeliveries / replay attempts collide here. The route
-- catches the unique-violation and returns a 200 ack so the vendor stops retrying.
CREATE UNIQUE INDEX "ai_workflow_execution_dedup_key"
  ON "ai_workflow_execution"("dedupKey");

-- CreateTable: inbound trigger binding (channel, workflow).
CREATE TABLE "ai_workflow_trigger" (
  "id" TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "channel" VARCHAR(40) NOT NULL,
  "name" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "signingSecret" TEXT,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "lastFiredAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_workflow_trigger_pkey" PRIMARY KEY ("id")
);

-- One trigger per (channel, workflow). Forks can drop and re-add this constraint
-- in a follow-up migration if they need multi-event-type triggers per workflow.
CREATE UNIQUE INDEX "ai_workflow_trigger_channel_workflowId_key"
  ON "ai_workflow_trigger"("channel", "workflowId");

CREATE INDEX "ai_workflow_trigger_workflowId_idx"
  ON "ai_workflow_trigger"("workflowId");

-- Channel-scoped active-trigger filter for the request-time lookup.
CREATE INDEX "ai_workflow_trigger_channel_isEnabled_idx"
  ON "ai_workflow_trigger"("channel", "isEnabled");

ALTER TABLE "ai_workflow_trigger"
  ADD CONSTRAINT "ai_workflow_trigger_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_workflow_trigger"
  ADD CONSTRAINT "ai_workflow_trigger_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
