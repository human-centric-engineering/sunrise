-- Item #24: WhatsApp / SMS channel.
-- Additive only — adds inbound conversation channel/provider columns and
-- a new outbound-message ledger. No data backfill required.

-- AlterTable
ALTER TABLE "ai_conversation"
    ADD COLUMN "channel" TEXT,
    ADD COLUMN "provider" TEXT,
    ADD COLUMN "fromAddress" TEXT,
    ADD COLUMN "lastInboundAt" TIMESTAMP(3),
    ADD COLUMN "smsOptedOut" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
-- Deliberately excludes `provider` so memory continuity survives a
-- vendor swap (e.g. Twilio SMS → Vonage SMS for the same end user).
CREATE INDEX "ai_conversation_channel_fromAddress_idx"
    ON "ai_conversation"("channel", "fromAddress");

-- CreateTable
CREATE TABLE "ai_outbound_message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "transactionId" TEXT,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_outbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_outbound_message_dedupKey_key"
    ON "ai_outbound_message"("dedupKey");

-- CreateIndex
CREATE INDEX "ai_outbound_message_conversationId_createdAt_idx"
    ON "ai_outbound_message"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ai_outbound_message"
    ADD CONSTRAINT "ai_outbound_message_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
