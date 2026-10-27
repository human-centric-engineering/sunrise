-- t-912: tools the provider runs itself (Anthropic web search) on an agent.
-- Nullable, so existing agents turn none on.

-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "providerTools" JSONB;
