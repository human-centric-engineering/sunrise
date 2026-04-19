-- AlterTable
ALTER TABLE "ai_message" ADD COLUMN     "ratedAt" TIMESTAMP(3),
ADD COLUMN     "rating" INTEGER;

-- CreateIndex
CREATE INDEX "ai_message_rating_idx" ON "ai_message"("rating");
