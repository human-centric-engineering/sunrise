-- t-991 (§127): the LLM privacy layer's install-wide settings.
--
-- `privacyMode` is added with the default `off`, which is what fills the
-- settings row an install already has: an upgrade sends every call as it did
-- before until an operator turns the layer on. The default is then changed to
-- `detect`, so a row created from now on (a new install) starts by counting
-- what agents meet. Changing a column default never rewrites existing rows, so
-- a mode an operator has set is left alone.

-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "privacyMode" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "privacyIgnoredEntityTypes" JSONB NOT NULL DEFAULT '["DATE", "LOCATION"]',
ADD COLUMN     "privacyProtectLocalProviders" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ai_orchestration_settings" ALTER COLUMN "privacyMode" SET DEFAULT 'detect';
