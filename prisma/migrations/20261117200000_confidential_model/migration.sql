-- The model for confidential messages (§130 t-1038). Nullable, no default:
-- an install answers nothing differently until an administrator chooses one.
ALTER TABLE "ai_orchestration_settings" ADD COLUMN "confidentialModelProvider" TEXT;
ALTER TABLE "ai_orchestration_settings" ADD COLUMN "confidentialModel" TEXT;
