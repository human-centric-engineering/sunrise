-- The interface language a user chose (§138 t-1071). Nullable, no default:
-- null follows the org's default and then the browser, so every existing
-- user is shown what they were shown before.
ALTER TABLE "user" ADD COLUMN "locale" VARCHAR(35);
