-- §109 t-739: index the two halves of the address match that subject access
-- and erasure use to find a person's notifications
-- (`webhookDeliveriesAddressedTo`): exact on "destination", and JSON
-- containment (@>) on "previousDestinations". Without both, that OR scans the
-- whole table — inside the erasure transaction, which has a timeout.
--
-- Not CONCURRENTLY (Prisma migrations run in a transaction), so each build
-- holds a lock that scales with the table. "previousDestinations" is NULL on
-- almost every row, so its GIN index is small.

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_destination_idx" ON "ai_webhook_delivery"("destination");

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_previousDestinations_idx" ON "ai_webhook_delivery" USING GIN ("previousDestinations" jsonb_path_ops);
