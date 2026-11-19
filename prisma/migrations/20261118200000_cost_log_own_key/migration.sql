-- §137 t-1046: mark the cost of a call made on an organisation's own AI key.
--
-- The vendor bills those calls to the org, so they count towards the agent's
-- monthly cap only, not the org's or the global one, and the cost reports
-- show them apart. No release before this one let an org hold a key (t-1044
-- ships beside this), so every existing row is platform spend and the default
-- is right for all of them: nothing is backfilled.

-- AlterTable
ALTER TABLE "ai_cost_log" ADD COLUMN     "ownKey" BOOLEAN NOT NULL DEFAULT false;
