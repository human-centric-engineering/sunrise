-- Add reasoningEffort to AiAgent
--
-- Controls how much reasoning the model does before producing visible
-- output. Maps to ReasoningEffort in lib/orchestration/llm/types.ts.
-- Honoured by reasoning-capable models (OpenAI o-series / gpt-5 via
-- `reasoning_effort`; Anthropic Claude 4 thinking models via
-- `thinking.budget_tokens`). Silently dropped on other models — no 400.
--
-- Nullable: when null, the runtime sends no reasoning-effort field and
-- the provider's default applies. Existing agents resolve via the
-- runtime default — no backfill needed.
--
-- Idempotent — re-running on a DB that already has the column is a no-op.

ALTER TABLE "ai_agent"
  ADD COLUMN IF NOT EXISTS "reasoningEffort" TEXT;
