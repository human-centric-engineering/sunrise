-- Image and PDF/document input toggles on AiAgent (default off — opt-in per agent).
ALTER TABLE "ai_agent" ADD COLUMN "enableImageInput" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_agent" ADD COLUMN "enableDocumentInput" BOOLEAN NOT NULL DEFAULT false;

-- Org-wide kill switches on the orchestration settings singleton (default on).
ALTER TABLE "ai_orchestration_settings" ADD COLUMN "imageInputGloballyEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ai_orchestration_settings" ADD COLUMN "documentInputGloballyEnabled" BOOLEAN NOT NULL DEFAULT true;
