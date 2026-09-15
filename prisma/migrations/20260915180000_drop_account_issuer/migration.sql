-- better-auth 1.7.3 restored the 1.6 account identity: (providerId, accountId).
--
-- 1.7.0 through 1.7.2 keyed an external account on (issuer, accountId), and
-- 20260825120000_add_account_issuer added the column and its unique index so
-- 1.7.1 could sign anyone in (#672). 1.7.3 reverted that — "we restored the
-- 1.6 account core schema ... and are committed to keeping the core schema
-- stable throughout v1" — so from 1.7.3 on nothing writes `issuer`. Left as
-- NOT NULL it rejects every insert into "account": sign-up, first social
-- sign-in and account linking all fail on the constraint, while existing users
-- (no insert) keep signing in and nothing in the toolchain says why.
--
-- Upstream guide:
-- https://better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-keeps-the-provider-key
--
-- Both statements are IF EXISTS on purpose. The guide's PostgreSQL recipe is
-- "relax to nullable and drop the index", and an operator whose sign-up was
-- failing may already have run it, or dropped the column by hand; this must
-- then be a no-op rather than a failed migration that P3009s every later
-- deploy. Note the index name: Prisma named the @@unique([issuer, accountId])
-- constraint "account_issuer_accountId_key". The guide's recipe drops
-- "account_issuer_accountId_uidx", which never existed on a Sunrise database —
-- running it as written leaves the index in place.
--
-- The column is dropped rather than relaxed: nothing reads it after 1.7.3,
-- its value is re-derivable from "providerId", and a nullable column nobody
-- owns is a permanent question for the next schema reader.

DROP INDEX IF EXISTS "account_issuer_accountId_key";

ALTER TABLE "account" DROP COLUMN IF EXISTS "issuer";
