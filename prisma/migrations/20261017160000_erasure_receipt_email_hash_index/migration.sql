-- t-805: every recipient writer now looks an erasure receipt up by address
-- hash before it writes, so the column it filters on is indexed.

-- CreateIndex
CREATE INDEX "data_erasure_receipt_subjectEmailHash_idx" ON "data_erasure_receipt"("subjectEmailHash");
