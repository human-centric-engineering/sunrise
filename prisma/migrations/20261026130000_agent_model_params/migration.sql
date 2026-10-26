-- t-911 / t-913: further model parameters on an agent. All nullable or
-- defaulted empty, so existing agents send nothing new.

-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "parallelToolCalls" BOOLEAN,
ADD COLUMN     "serviceTier" TEXT,
ADD COLUMN     "stopSequences" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "topP" DOUBLE PRECISION,
ADD COLUMN     "verbosity" TEXT;
