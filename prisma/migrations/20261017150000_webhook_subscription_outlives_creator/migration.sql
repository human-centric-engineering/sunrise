-- t-782: a webhook subscription outlives the admin who created it. Erasing
-- them used to delete it (and stop the integration it fed); now the creator
-- is set to null and the subscription keeps delivering, managed by whoever
-- the authorization policy admits to an ownerless subscription.

-- AlterTable
ALTER TABLE "ai_webhook_subscription" ALTER COLUMN "createdBy" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "ai_webhook_subscription" DROP CONSTRAINT "ai_webhook_subscription_createdBy_fkey";

-- AddForeignKey
ALTER TABLE "ai_webhook_subscription" ADD CONSTRAINT "ai_webhook_subscription_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
