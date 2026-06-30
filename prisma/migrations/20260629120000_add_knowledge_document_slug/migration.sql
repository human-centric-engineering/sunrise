-- Add the stable cross-environment export key for knowledge documents.
-- Mirrors `KnowledgeTag.slug`. Deterministic so the "same" document (same name +
-- content) gets the same slug in any environment, letting agent->document grants
-- round-trip through export/import and backup/restore (see #338).

-- 1. Add nullable so existing rows can be backfilled before the constraints land.
ALTER TABLE "ai_knowledge_document" ADD COLUMN "slug" TEXT;

-- 2. Backfill: slugify(name) + '-' + left(fileHash, 8). This MUST match the TS
--    helper buildDocumentSlugBase() exactly (lowercase, non-alphanumeric -> '-',
--    trim leading/trailing '-', cap 60 chars, empty name -> 'document'), so a
--    later re-upload of the same content+name reproduces the same slug. Rows that
--    compute the same slug are disambiguated with a '-N' suffix (ordered by id,
--    N starting at 2 — same convention as the create-time uniqueness loop) so the
--    NOT NULL UNIQUE constraint below can be applied to legacy data.
WITH base AS (
  SELECT
    "id",
    COALESCE(
      NULLIF(
        LEFT(
          TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER("name"), '[^a-z0-9]+', '-', 'g')),
          60
        ),
        ''
      ),
      'document'
    ) || '-' || LEFT("fileHash", 8) AS computed
  FROM "ai_knowledge_document"
),
ranked AS (
  SELECT
    "id",
    computed,
    ROW_NUMBER() OVER (PARTITION BY computed ORDER BY "id") AS rn
  FROM base
)
UPDATE "ai_knowledge_document" d
SET "slug" = CASE WHEN r.rn = 1 THEN r.computed ELSE r.computed || '-' || r.rn END
FROM ranked r
WHERE d."id" = r."id";

-- 3. Enforce NOT NULL + uniqueness now that every row carries a value.
ALTER TABLE "ai_knowledge_document" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "ai_knowledge_document_slug_key" ON "ai_knowledge_document"("slug");
