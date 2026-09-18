-- §106 t-673: credentials minted between 0.12.0 and this release carry
-- orgId = NULL — the column landed in 20260917120000_org_identity, backfilled
-- once, and nothing wrote it at mint until now. At `single` the read rule
-- resolves such a row to the install org, so nothing was wrong; at `multi`
-- a NULL-org credential is refused, so an install that switches modes must
-- never meet one. The four statements are the identity migration's own,
-- verbatim (tests/unit/lib/tenancy/migration.test.ts holds them equal): the
-- WHERE keeps them idempotent, and the `admin` exemption keeps a platform key
-- a platform key. From this release every mint writes the column.
UPDATE "ai_api_key"            SET "orgId" = 'install' WHERE "orgId" IS NULL AND NOT ('admin' = ANY("scopes"));
UPDATE "ai_agent_embed_token"  SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "ai_agent_invite_token" SET "orgId" = 'install' WHERE "orgId" IS NULL;
UPDATE "mcp_api_key"           SET "orgId" = 'install' WHERE "orgId" IS NULL;
