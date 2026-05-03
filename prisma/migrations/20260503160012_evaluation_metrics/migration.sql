-- AlterTable: named-metric scores attached by the judge LLM at completion / rescore.
ALTER TABLE "ai_evaluation_log" ADD COLUMN     "faithfulnessScore" DOUBLE PRECISION,
ADD COLUMN     "groundednessScore" DOUBLE PRECISION,
ADD COLUMN     "judgeReasoning" JSONB,
ADD COLUMN     "relevanceScore" DOUBLE PRECISION;

-- AlterTable: aggregate of the per-log scores plus judge metadata, computed
-- once at session completion and refreshed on rescore.
ALTER TABLE "ai_evaluation_session" ADD COLUMN     "metricSummary" JSONB;
