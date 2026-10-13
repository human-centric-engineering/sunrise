-- t-783: index each delivery table's payload for JSON containment (@>), so
-- subject access and erasure can find the deliveries whose event names a
-- person — their id, or one of their conversations or workflow runs
-- (`lib/privacy/delivery-payloads.ts`) — without scanning the table inside
-- the erasure transaction, which has a timeout.
--
-- Not CONCURRENTLY (Prisma migrations run in a transaction), so each build
-- holds a lock that scales with the table. Retention pruning bounds both.

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_payload_idx" ON "ai_webhook_delivery" USING GIN ("payload" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "ai_event_hook_delivery_payload_idx" ON "ai_event_hook_delivery" USING GIN ("payload" jsonb_path_ops);
