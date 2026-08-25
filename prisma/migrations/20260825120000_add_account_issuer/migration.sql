-- better-auth 1.7 scopes account identity by (issuer, accountId).
--
-- Until 1.6 an external identity was keyed on (providerId, accountId).
-- 1.7 replaced that with (issuer, accountId), where `issuer` names the
-- authority that minted the subject, and demoted `providerId` to local
-- configuration that is never an identity key. Every credential *and* social
-- sign-in path in 1.7 filters on `issuer`, so a database without this column
-- fails closed: the Google callback throws
-- `Unknown argument 'issuer'` out of `findAccountOwnerByKey`, and
-- email/password sign-in reads `undefined` for `account.issuer`, matches no
-- credential row, and answers "invalid email or password". Sunrise 0.11.0
-- shipped better-auth 1.7.1 without this column, which took out both.
--
-- Upstream guide:
-- https://better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-is-scoped-by-issuer
--
-- Two steps below abort deliberately rather than guess (step 2) or merge two
-- people's identities (step 5). Aborting is the right answer, but be aware of
-- what it costs: `prisma migrate deploy` records a failed migration, and every
-- later deploy stops with P3009 until it is cleared with
-- `prisma migrate resolve --rolled-back 20260825120000_add_account_issuer`.
-- Both RAISE messages say so; this note is here for whoever reads the file
-- first. Deployments that run migrations automatically -- Vercel here, and the
-- Docker migrator from #583 -- will keep failing until that is run.

-- 1. Add the column nullable so existing rows survive long enough to backfill.
--
-- IF NOT EXISTS because the likeliest reader of this file is an operator whose
-- sign-in is currently down, and the obvious emergency patch is to add the
-- nullable column by hand -- at which point better-auth 1.7 starts writing
-- `issuer` itself and service recovers. Without the guard, THIS release then
-- dies on 42701 (column already exists), is recorded as failed, and P3009s
-- every later deploy: the one migration meant to end the outage would extend
-- it. Steps 3-6 still repair and enforce such a database correctly.
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" TEXT;

-- 2. Refuse to guess. Sunrise ships exactly two providers, and only their
--    issuers are known here. An OIDC provider carries an issuer of its own
--    that cannot be derived from `providerId`, so a fork that added one must
--    decide deliberately rather than inherit a synthetic `local:oauth:` value
--    that would silently strand its users at the login screen. Fail loudly and
--    say exactly what to do.
DO $$
DECLARE
  unknown_providers TEXT;
BEGIN
  SELECT string_agg(DISTINCT "providerId", ', ' ORDER BY "providerId")
    INTO unknown_providers
    FROM "account"
   WHERE "providerId" NOT IN ('credential', 'google');

  IF unknown_providers IS NOT NULL THEN
    RAISE EXCEPTION
      'account.issuer backfill does not know these providerId values: %. Extend this migration before deploying: an OIDC provider uses its verified issuer (e.g. Microsoft uses https://login.microsoftonline.com/<tenant>/v2.0), and a plain OAuth2 provider without an issuer uses ''local:oauth:'' || <percent-encoded providerId>. See https://better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-is-scoped-by-issuer -- RECOVERY: this abort leaves the migration recorded as FAILED, and every later deploy then stops with P3009 until you run: prisma migrate resolve --rolled-back 20260825120000_add_account_issuer (on Neon, prefix PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=true).',
      unknown_providers;
  END IF;
END $$;

-- 3. Credential identity is (local:credential, user.id). 1.7's sign-in path
--    asserts `accountId = user.id` for credential rows; 1.6 already wrote them
--    that way, so this is a no-op repair for rows created by sign-up and a
--    correction for any written by hand.
UPDATE "account" SET "accountId" = "userId"
 WHERE "providerId" = 'credential' AND "accountId" <> "userId";

-- 4. Backfill.
UPDATE "account" SET "issuer" = 'local:credential' WHERE "providerId" = 'credential';
UPDATE "account" SET "issuer" = 'https://accounts.google.com' WHERE "providerId" = 'google';

-- 5. Report identity collisions by name before the unique index reports them
--    as an opaque constraint violation. Two rows sharing (issuer, accountId)
--    have two quite different causes, and the message distinguishes them: two
--    local users claiming one external identity is a decision only a human can
--    make, whereas two credential rows for the SAME user -- which step 3 can
--    itself bring into view, by collapsing a hand-written accountId onto the
--    owner's id -- is just a stale row to delete. Neither is something this
--    migration should decide.
DO $$
DECLARE
  collisions TEXT;
BEGIN
  SELECT string_agg(
           format('(%s, %s): %s rows across %s user(s) — %s',
                  issuer, "accountId", row_count, user_count,
                  CASE WHEN user_count = 1
                       THEN 'duplicate rows for ONE user, which step 3 can also collapse into view; delete the stale row'
                       ELSE 'DISTINCT users claiming one external identity; a human has to decide which keeps it'
                  END),
           '; ')
    INTO collisions
    FROM (
      SELECT "issuer", "accountId",
             COUNT(*) AS row_count,
             COUNT(DISTINCT "userId") AS user_count
        FROM "account"
       GROUP BY "issuer", "accountId"
      HAVING COUNT(*) > 1
    ) duplicates;

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'account rows share an (issuer, accountId) identity and cannot be made unique: %. Read the per-row note: duplicates belonging to one user are a stale row to delete, not an identity to adjudicate. RECOVERY: this abort leaves the migration recorded as FAILED, and every later deploy then stops with P3009 until you run: prisma migrate resolve --rolled-back 20260825120000_add_account_issuer (on Neon, prefix PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=true). Resolve the duplicates, then deploy again.',
      collisions;
  END IF;
END $$;

-- 6. Enforce. Every row is backfilled by construction: step 2 proved the
--    providerId set is exactly the one step 4 covers.
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_key" ON "account"("issuer", "accountId");
