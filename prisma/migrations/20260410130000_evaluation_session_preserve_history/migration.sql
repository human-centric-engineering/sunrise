-- Preserve evaluation history when an agent is deleted.
-- Previously agentId was NOT NULL with ON DELETE CASCADE, so deleting an agent
-- wiped all its evaluation sessions (and their logs via cascade). Evaluation
-- sessions are audit records: we want them to outlive the agent they tested.
--
-- This mirrors the pattern used by ai_cost_log, which also uses nullable agentId
-- + SET NULL so cost history survives agent deletion.

-- Drop the existing foreign key
ALTER TABLE "ai_evaluation_session"
  DROP CONSTRAINT "ai_evaluation_session_agentId_fkey";

-- Make agentId nullable
ALTER TABLE "ai_evaluation_session"
  ALTER COLUMN "agentId" DROP NOT NULL;

-- Recreate the foreign key with ON DELETE SET NULL
ALTER TABLE "ai_evaluation_session"
  ADD CONSTRAINT "ai_evaluation_session_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
