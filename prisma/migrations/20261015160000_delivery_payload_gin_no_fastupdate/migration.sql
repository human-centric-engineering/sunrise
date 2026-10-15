-- t-806: the delivery payload GIN indexes write new entries straight into the
-- index, not into a pending list (`fastupdate`, on by default).
--
-- An erasure redacts a person's deliveries in committed chunks and then, in
-- its transaction, matches them all again. With a pending list, every entry
-- those rewrites added sits in it until a vacuum, and each containment probe
-- of the match scans the whole list: measured at 29.6 s for the match over
-- 200,000 rows just after the rewrite, 3.2 s once vacuumed, and 4.7 s with
-- fastupdate off and no vacuum. The transaction has 60 s, so whether a heavy
-- erasure fitted depended on when autovacuum last ran. Each delivery insert
-- now pays its index update itself, which is small for one event's payload.
--
-- Prisma cannot express index storage parameters, so `db:drift-check`
-- probes this (A11, A12; see .context/database/prisma-unmodelled-objects.md).
ALTER INDEX "ai_webhook_delivery_payload_idx" SET (fastupdate = off);
ALTER INDEX "ai_event_hook_delivery_payload_idx" SET (fastupdate = off);
