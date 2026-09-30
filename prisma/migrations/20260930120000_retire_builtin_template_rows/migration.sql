-- Retire the built-in workflow template rows (§116 t-727).
--
-- Seed 004 mirrored the built-in templates (`BUILTIN_WORKFLOW_TEMPLATES`)
-- into install-org rows. They are now served from code to every org, and
-- the seed is gone, so these rows are stale duplicates.
--
-- Each row is soft-deleted, not removed: it is switched off and stops being
-- a template. The row, its versions and every execution that references it
-- are kept. An install that ran one directly (a schedule, a trigger, a
-- `run_workflow` binding) can switch it back on from the workflows list,
-- and it runs as an ordinary workflow.
--
-- Only rows still flagged as templates are touched: one an admin already
-- turned into an ordinary workflow is theirs, and is left alone. The slug
-- list is the twelve built-ins as of this migration; a template added later
-- was never seeded as a row. On a fresh database this matches nothing.
UPDATE "ai_workflow"
SET "isActive" = false,
    "isTemplate" = false,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "isTemplate" = true
  AND "isSystem" = false
  AND "slug" IN (
    'tpl-customer-support',
    'tpl-content-pipeline',
    'tpl-saas-backend',
    'tpl-research-agent',
    'tpl-conversational-learning',
    'tpl-data-pipeline',
    'tpl-outreach-safety',
    'tpl-code-review',
    'tpl-autonomous-research',
    'tpl-cited-knowledge-advisor',
    'tpl-scheduled-source-monitor',
    'tpl-inbound-conversation-handler'
  );
