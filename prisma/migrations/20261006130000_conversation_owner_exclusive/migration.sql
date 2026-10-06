-- A9 (#705, t-765): a conversation belongs to a user or to an embed visitor,
-- never both. Visitors are kept apart from users (owner ruling, 2026-10-06): a
-- row carrying both would reach the user's export and erasure (which select
-- on "userId") and stay continuable by the visitor (on "embedVisitorId").
-- Prisma cannot model a CHECK constraint, so `prisma migrate dev` would emit a
-- DROP for it; see the drift-warning block on AiConversation and
-- .context/database/prisma-unmodelled-objects.md. `npm run db:drift-check`
-- probes it.
ALTER TABLE "ai_conversation"
  ADD CONSTRAINT "ai_conversation_owner_exclusive"
  CHECK ("userId" IS NULL OR "embedVisitorId" IS NULL);
