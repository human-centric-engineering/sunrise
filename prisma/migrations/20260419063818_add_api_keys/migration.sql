-- CreateTable
CREATE TABLE "ai_api_key" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['chat']::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_api_key_keyHash_key" ON "ai_api_key"("keyHash");

-- CreateIndex
CREATE INDEX "ai_api_key_userId_idx" ON "ai_api_key"("userId");

-- CreateIndex
CREATE INDEX "ai_api_key_keyHash_idx" ON "ai_api_key"("keyHash");

-- AddForeignKey
ALTER TABLE "ai_api_key" ADD CONSTRAINT "ai_api_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
