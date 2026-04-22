-- CreateTable
CREATE TABLE "ai_message_embedding" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,

    CONSTRAINT "ai_message_embedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_message_embedding_messageId_key" ON "ai_message_embedding"("messageId");

-- CreateIndex
CREATE INDEX "ai_message_embedding_messageId_idx" ON "ai_message_embedding"("messageId");

-- AddForeignKey
ALTER TABLE "ai_message_embedding" ADD CONSTRAINT "ai_message_embedding_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ai_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
