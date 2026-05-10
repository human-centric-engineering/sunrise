-- Voice input toggle on AiAgent (default off — opt-in per agent).
ALTER TABLE "ai_agent" ADD COLUMN "enableVoiceInput" BOOLEAN NOT NULL DEFAULT false;

-- Org-wide kill switch on the orchestration settings singleton (default on).
ALTER TABLE "ai_orchestration_settings" ADD COLUMN "voiceInputGloballyEnabled" BOOLEAN NOT NULL DEFAULT true;
