-- Add the `kind` discriminator to AiAgent so judge agents (driven by
-- the evaluation worker / manual-session scorer) are mutually exclusive
-- from chat agents (driven by streamChat / embed). Future roles like
-- 'subject' (workflow-only) become new enum values here.
--
-- Default 'chat' backfills every existing row so no agent loses its
-- behaviour on apply. The string-discriminator pattern matches
-- AiEvaluationRun.subjectKind elsewhere in the schema.

-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'chat';
