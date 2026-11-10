-- t-1005 (#1181): a support row written before `actingOrgId` existed already
-- names the org it was made in (`supportOrgId`, stamped from the same tenant
-- context), so the org's history can include it. Other earlier rows name no
-- org and stay null: nothing on them says reliably where they were made.
UPDATE "ai_admin_audit_log"
SET "actingOrgId" = "supportOrgId"
WHERE "supportOrgId" IS NOT NULL AND "actingOrgId" IS NULL;
