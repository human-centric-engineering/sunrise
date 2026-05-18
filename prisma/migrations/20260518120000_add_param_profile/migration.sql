-- Add paramProfile to AiProviderModel
--
-- Wire-level parameter convention that determines how the OpenAI-compatible
-- provider class serialises a request:
--   - 'openai-legacy'     → `max_tokens`, free `temperature` (gpt-4o, gpt-4, Llama, Mixtral, …)
--   - 'openai-reasoning'  → `max_completion_tokens`, `temperature` locked to 1 (o-series, gpt-5)
--   - 'anthropic'         → `max_tokens` required, supports `top_k` and `thinking` (Claude family)
--   - 'gemini'            → `maxOutputTokens` (reserved for future Gemini provider class)
--
-- Nullable column, no backfill: existing rows resolve via the runtime
-- fallback `deriveParamProfile()` in lib/orchestration/llm/model-heuristics.ts,
-- which regex-derives the profile from the model id + provider. Setting
-- the column is the authoritative path; the runtime always prefers it
-- when present.
--
-- Idempotent — re-running on a DB that already has the column is a no-op.

ALTER TABLE "ai_provider_model"
  ADD COLUMN IF NOT EXISTS "paramProfile" TEXT;
