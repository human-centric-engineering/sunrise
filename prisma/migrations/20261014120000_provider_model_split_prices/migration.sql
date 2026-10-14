-- t-774: separate input and output prices on Model Matrix rows.
-- Additive and nullable: existing rows keep their blended
-- `costPerMillionTokens`, which stays the fallback for both rates.
ALTER TABLE "ai_provider_model" ADD COLUMN "inputCostPerMillionTokens" DOUBLE PRECISION,
ADD COLUMN "outputCostPerMillionTokens" DOUBLE PRECISION;
