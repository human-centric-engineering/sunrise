-- §109 t-739: a webhook or event-hook delivery records where it was sent, and
-- outlives the subscription or hook that sent it.
--
-- The parent FK becomes nullable with ON DELETE SET NULL (was CASCADE), so
-- deleting a subscription or hook no longer deletes its delivery history. The
-- "orgId" cascade is untouched: erasing an org still removes its deliveries.
-- The org_isolation policies on both tables key on "orgId" and are unaffected.
--
-- The three new columns are left NULL here. Existing rows are backfilled by the
-- `022-delivery-destinations` seed unit, because the reduced form (the URL's
-- origin) and the keyed fingerprint are computed in application code
-- with a key SQL cannot see. That backfill reads each row's CURRENT parent, so
-- it is the best available value, not a record of where the row was sent.

-- AlterTable
ALTER TABLE "ai_webhook_delivery" ADD COLUMN     "destination" TEXT,
ADD COLUMN     "destinationFingerprint" TEXT,
ADD COLUMN     "previousDestinations" JSONB,
ALTER COLUMN "subscriptionId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ai_event_hook_delivery" ADD COLUMN     "destination" TEXT,
ADD COLUMN     "destinationFingerprint" TEXT,
ADD COLUMN     "previousDestinations" JSONB,
ALTER COLUMN "hookId" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "ai_webhook_delivery" DROP CONSTRAINT "ai_webhook_delivery_subscriptionId_fkey";

-- DropForeignKey
ALTER TABLE "ai_event_hook_delivery" DROP CONSTRAINT "ai_event_hook_delivery_hookId_fkey";

-- AddForeignKey
ALTER TABLE "ai_webhook_delivery" ADD CONSTRAINT "ai_webhook_delivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "ai_webhook_subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_event_hook_delivery" ADD CONSTRAINT "ai_event_hook_delivery_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "ai_event_hook"("id") ON DELETE SET NULL ON UPDATE CASCADE;
