-- t-1005 (#1181): an install with one org (every `single` install, and a
-- `multi` one with no customer yet) made every earlier admin audit row in it,
-- so its whole history is that org's. With more than one org, a member's row
-- cannot be placed (people span orgs) and stays null; support rows were
-- placed by the previous migration.
UPDATE "ai_admin_audit_log"
SET "actingOrgId" = (SELECT "id" FROM "org" LIMIT 1)
WHERE "actingOrgId" IS NULL AND (SELECT count(*) FROM "org") = 1;
