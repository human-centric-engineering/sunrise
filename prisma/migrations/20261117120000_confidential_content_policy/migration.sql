-- t-1037 (§130): what a call holding confidential content may do, per group,
-- install-wide and per agent; and the provider tick "Trusted with
-- confidential content".
--
-- The two settings columns are added with the default `allow`, which is what
-- fills the settings row an install already has: an upgrade records what its
-- agents meet and changes nothing sent (owner ruling, 2026-11-17). The
-- defaults are then changed, so a row created from now on (a new install)
-- warns for Personal and allows Commercial. Changing a column default never
-- rewrites existing rows, so nothing an operator sets is touched. The t-991
-- two-step (20261111120000_privacy_settings).

-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "privacyConfidentialPersonal" TEXT NOT NULL DEFAULT 'allow',
ADD COLUMN     "privacyConfidentialCommercial" TEXT NOT NULL DEFAULT 'allow';

-- AlterTable
ALTER TABLE "ai_orchestration_settings" ALTER COLUMN "privacyConfidentialPersonal" SET DEFAULT 'warn';

-- An agent's own policies: null for every agent, which uses the install's. A
-- set policy only ever tightens the install's.

-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "privacyConfidentialPersonal" TEXT,
ADD COLUMN     "privacyConfidentialCommercial" TEXT;

-- Off for every provider until an operator ticks it.

-- AlterTable
ALTER TABLE "ai_provider_config" ADD COLUMN     "trustedForConfidential" BOOLEAN NOT NULL DEFAULT false;
