-- An email delivery's language (§138 t-1075). Nullable, no default: webhook
-- rows have none, and an email row created before this goes in English, as it
-- did when it was first attempted, so its retry matches its idempotency key.
ALTER TABLE "ai_webhook_delivery" ADD COLUMN "emailLocale" VARCHAR(35);
