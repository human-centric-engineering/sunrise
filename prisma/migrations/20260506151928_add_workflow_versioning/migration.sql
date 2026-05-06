-- Workflow versioning: publish / draft / rollback.
--
-- Replaces the inline `workflowDefinition` JSON column and the
-- `workflowDefinitionHistory` JSON array on `ai_workflow` with a formal
-- `ai_workflow_version` table (mirrors `ai_agent_version`). Each workflow
-- gains a `publishedVersionId` FK and an in-progress `draftDefinition` JSON
-- column. `ai_workflow_execution` rows pin to a specific version via
-- `versionId` so a mid-edit draft never alters in-flight runs.
--
-- Backfill: every existing history entry becomes versions 1..N (oldest-first),
-- and the current `workflowDefinition` becomes version N+1 — pointed to by
-- `publishedVersionId`. Existing executions stay un-pinned (versionId = NULL);
-- only future executions are stamped.

-- 1. New table
CREATE TABLE "ai_workflow_version" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeSummary" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_workflow_version_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_workflow_version_workflowId_idx" ON "ai_workflow_version"("workflowId");
CREATE UNIQUE INDEX "ai_workflow_version_workflowId_version_key" ON "ai_workflow_version"("workflowId", "version");

-- 2. New columns on ai_workflow (nullable; populated below)
ALTER TABLE "ai_workflow"
    ADD COLUMN "draftDefinition" JSONB,
    ADD COLUMN "publishedVersionId" TEXT;

-- 3. New column on ai_workflow_execution
ALTER TABLE "ai_workflow_execution" ADD COLUMN "versionId" TEXT;

-- 4. Backfill versions + pin publishedVersionId
DO $$
DECLARE
    wf RECORD;
    history_entry JSONB;
    new_version_id TEXT;
    next_version_num INTEGER;
BEGIN
    FOR wf IN
        SELECT id, "workflowDefinition", "workflowDefinitionHistory", "createdBy", "updatedAt"
        FROM "ai_workflow"
    LOOP
        next_version_num := 1;

        FOR history_entry IN
            SELECT * FROM jsonb_array_elements(COALESCE(wf."workflowDefinitionHistory", '[]'::jsonb))
        LOOP
            new_version_id := gen_random_uuid()::text;
            INSERT INTO "ai_workflow_version" (
                "id", "workflowId", "version", "snapshot", "changeSummary", "createdBy", "createdAt"
            ) VALUES (
                new_version_id,
                wf.id,
                next_version_num,
                history_entry->'definition',
                NULL,
                COALESCE(history_entry->>'changedBy', wf."createdBy"),
                COALESCE((history_entry->>'changedAt')::timestamp, wf."updatedAt")
            );
            next_version_num := next_version_num + 1;
        END LOOP;

        new_version_id := gen_random_uuid()::text;
        INSERT INTO "ai_workflow_version" (
            "id", "workflowId", "version", "snapshot", "changeSummary", "createdBy", "createdAt"
        ) VALUES (
            new_version_id,
            wf.id,
            next_version_num,
            wf."workflowDefinition",
            NULL,
            wf."createdBy",
            wf."updatedAt"
        );

        UPDATE "ai_workflow" SET "publishedVersionId" = new_version_id WHERE id = wf.id;
    END LOOP;
END $$;

-- 5. Drop legacy columns
ALTER TABLE "ai_workflow"
    DROP COLUMN "workflowDefinition",
    DROP COLUMN "workflowDefinitionHistory";

-- 6. Foreign keys + indexes
ALTER TABLE "ai_workflow_version"
    ADD CONSTRAINT "ai_workflow_version_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "ai_workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_workflow_version"
    ADD CONSTRAINT "ai_workflow_version_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_workflow"
    ADD CONSTRAINT "ai_workflow_publishedVersionId_fkey"
    FOREIGN KEY ("publishedVersionId") REFERENCES "ai_workflow_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ai_workflow_publishedVersionId_idx" ON "ai_workflow"("publishedVersionId");

ALTER TABLE "ai_workflow_execution"
    ADD CONSTRAINT "ai_workflow_execution_versionId_fkey"
    FOREIGN KEY ("versionId") REFERENCES "ai_workflow_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ai_workflow_execution_versionId_idx" ON "ai_workflow_execution"("versionId");
