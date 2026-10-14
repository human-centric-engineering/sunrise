-- A10 (t-774): a Model Matrix row's chat prices are set as a pair or not at
-- all. Half a price records the other half of every chat turn at $0 (or,
-- through the blended fallback, at a rate nobody set), so every writer —
-- routes, form, audit capabilities, seed, a fork's script — must keep both
-- or neither. The application checks the pair too; this holds it for writers
-- that don't, and for two concurrent PATCHes that each pass the check alone.
-- Prisma cannot model a CHECK constraint, so `prisma migrate dev` would emit a
-- DROP for it; see the drift-warning block on AiProviderModel and
-- .context/database/prisma-unmodelled-objects.md. `npm run db:drift-check`
-- probes it.
ALTER TABLE "ai_provider_model"
  ADD CONSTRAINT "ai_provider_model_price_pair"
  CHECK (("inputCostPerMillionTokens" IS NULL) = ("outputCostPerMillionTokens" IS NULL));
