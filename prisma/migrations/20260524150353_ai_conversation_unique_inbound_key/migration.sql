-- Replace the non-unique (channel, fromAddress) index with a UNIQUE
-- constraint on (agentId, channel, fromAddress). The DB-side UNIQUE
-- serialises concurrent inbound webhooks for the same sender to a
-- single AiConversation row, closing the find-or-create race exposed
-- in code-review of PR #218.
--
-- PostgreSQL treats NULLs as distinct in UNIQUE constraints (default
-- NULLS DISTINCT), so existing AiConversation rows with NULL channel
-- and NULL fromAddress (web/admin chat) do not collide.

DROP INDEX IF EXISTS "ai_conversation_channel_fromAddress_idx";

ALTER TABLE "ai_conversation"
  ADD CONSTRAINT "ai_conversation_inbound_key"
  UNIQUE ("agentId", "channel", "fromAddress");
