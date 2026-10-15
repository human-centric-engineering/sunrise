-- Who decides a platform agent's provider and model (t-798). NULL until the
-- platform-agent reconcile classifies the row; see the column comment in
-- prisma/schema/orchestration-agents.prisma.
ALTER TABLE "ai_agent" ADD COLUMN "bindingOwner" TEXT;
