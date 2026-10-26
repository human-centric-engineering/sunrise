-- t-909: prompt-cache token counts on each cost row. Nullable, no default:
-- rows written before this, and calls whose provider reported no cache use,
-- carry NULL.

-- AlterTable
ALTER TABLE "ai_cost_log" ADD COLUMN     "cacheReadTokens" INTEGER,
ADD COLUMN     "cacheWriteTokens" INTEGER;
