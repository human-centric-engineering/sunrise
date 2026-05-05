-- AlterTable: add OTEL trace correlation columns to ai_cost_log.
-- Strict additive change — historical rows have NULL traceId/spanId, which
-- correctly reflects that they were not emitted under an active tracer.
ALTER TABLE "ai_cost_log" ADD COLUMN "spanId" TEXT,
ADD COLUMN "traceId" TEXT;

-- CreateIndex: traceId is the join key for "show me everything that happened
-- inside this trace". A simple btree on traceId is sufficient — most lookups
-- are exact-match via OTEL backends correlating from a span ID.
CREATE INDEX "ai_cost_log_traceId_idx" ON "ai_cost_log"("traceId");
