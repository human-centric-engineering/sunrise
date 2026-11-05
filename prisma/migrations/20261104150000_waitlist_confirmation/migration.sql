-- §125 t-977: cap the waitlist emails at one an hour per entry.
-- Additive and nullable: an existing entry has never been mailed.

-- AlterTable
ALTER TABLE "waitlist_entry" ADD COLUMN     "lastEmailedAt" TIMESTAMP(3);
