-- §125 t-975: a receipt for a person erased from the waitlist with no account.
-- Additive: every existing receipt is an account receipt, and keeps its id.

-- AlterTable
ALTER TABLE "data_erasure_receipt" ADD COLUMN     "subjectKind" TEXT NOT NULL DEFAULT 'account',
ALTER COLUMN "subjectUserId" DROP NOT NULL;

-- An account receipt names its account; a waitlist receipt names none. The
-- readers that look a receipt up by subjectUserId (finishedErasure(), the
-- subject export's account arm) do not read the kind. Not modelled by Prisma: drift probe A13 in
-- scripts/db/check-drift.ts.
ALTER TABLE "data_erasure_receipt" ADD CONSTRAINT "data_erasure_receipt_subject_kind" CHECK (
  ("subjectKind" = 'account' AND "subjectUserId" IS NOT NULL)
  OR ("subjectKind" = 'waitlist' AND "subjectUserId" IS NULL)
);
