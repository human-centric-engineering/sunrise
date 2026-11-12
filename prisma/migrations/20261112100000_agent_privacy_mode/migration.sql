-- t-1010 (§127): an agent's own LLM privacy mode.
--
-- Nullable, and null for every existing agent: an agent uses the install's
-- mode until someone sets one. A set mode only ever tightens the install's.

-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "privacyMode" TEXT;
