-- CreateTable
CREATE TABLE "contact_submission" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "contact_submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_submission_createdAt_idx" ON "contact_submission"("createdAt");

-- CreateIndex
CREATE INDEX "contact_submission_read_idx" ON "contact_submission"("read");
