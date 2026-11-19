-- Vendor retirement on catalogue models (§136 t-1064). Both nullable, no
-- default: a model nobody marks behaves exactly as before.
--
-- `retiresAt`: the day the vendor stops serving the model. The retiring /
-- retired state is derived from it at read time, so no job flips it.
-- `replacementId`: the successor on the same provider. The same-provider
-- rule spans two rows, so the application checks it (`checkReplacement`);
-- the foreign key only keeps it pointing at a row that exists.
--
-- Hand-written, not `migrate dev`: this table carries the unmodelled CHECK
-- `ai_provider_model_price_pair`, which a generated migration would drop.
ALTER TABLE "ai_provider_model" ADD COLUMN "retiresAt" TIMESTAMP(3);
ALTER TABLE "ai_provider_model" ADD COLUMN "replacementId" TEXT;

CREATE INDEX "ai_provider_model_replacementId_idx" ON "ai_provider_model"("replacementId");

ALTER TABLE "ai_provider_model" ADD CONSTRAINT "ai_provider_model_replacementId_fkey" FOREIGN KEY ("replacementId") REFERENCES "ai_provider_model"("id") ON DELETE SET NULL ON UPDATE CASCADE;
