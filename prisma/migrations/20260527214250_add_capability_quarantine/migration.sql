-- Capability quarantine state (item #42).
--
-- Three additive columns on AiCapability for emergency-disable / quarantine.
-- Distinct from isActive: quarantineState is incident-response (a vendor API
-- misbehaving, a tool sending wrong data), while isActive is the routine
-- on/off switch. See `.context/orchestration/capabilities.md` (Quarantine).
--
-- NOTE: `prisma migrate dev` also auto-generated drops/renames for
-- `idx_ai_knowledge_chunk_search_vector`, `idx_message_embedding`,
-- `ai_knowledge_chunk.searchVector DEFAULT`, and a RENAME of
-- `ai_conversation_inbound_key`. All four are removed here per the
-- documented drift pattern (see schema comments at lines 914-922, 1058-1068
-- of `prisma/schema.prisma` and the NOTE in
-- `20260525072647_evaluations_phase1_foundations/migration.sql:155-160`).
-- Those entities are managed via raw SQL or pinned names and must not be
-- touched by unrelated migrations.
--
-- IF NOT EXISTS guards are present because an earlier run of this migration
-- partially applied the column adds before crashing on the (now-removed)
-- drift cleanup. They're a no-op on fresh installs.

-- AlterTable
ALTER TABLE "ai_capability"
  ADD COLUMN IF NOT EXISTS "quarantineReason" TEXT,
  ADD COLUMN IF NOT EXISTS "quarantineState" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "quarantineUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_capability_quarantineState_idx" ON "ai_capability"("quarantineState");
