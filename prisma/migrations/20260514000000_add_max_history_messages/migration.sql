-- Per-agent override for the message-count cap on conversation history
-- (the behavioural memory knob). Distinct from `maxHistoryTokens`, which
-- protects the model's context window. NULL = use platform default
-- (MAX_HISTORY_MESSAGES). 0 = stateless agent (no prior history re-sent).
ALTER TABLE "ai_agent" ADD COLUMN "maxHistoryMessages" INTEGER;
