-- DropIndex
DROP INDEX "contact_submission_createdAt_idx";

-- DropIndex
DROP INDEX "contact_submission_read_idx";

-- DropIndex
DROP INDEX "user_email_idx";

-- CreateIndex
CREATE INDEX "contact_submission_read_createdAt_idx" ON "contact_submission"("read", "createdAt");

-- CreateIndex
CREATE INDEX "verification_expiresAt_idx" ON "verification"("expiresAt");
