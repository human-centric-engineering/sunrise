-- §125 t-977: an unconfirmed entry's retention window, and a cap on its links.
-- Existing rows take the migration's time as their window start: none of them
-- was ever sent a confirmation link, so their join date says nothing about how
-- long they have had to confirm.

-- AlterTable
ALTER TABLE "waitlist_entry" ADD COLUMN     "confirmLinksSent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "confirmWindowFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
