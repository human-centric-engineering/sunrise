-- Add `completedAt` to the running-step side table so a parallel branch
-- can record its real finish time *while siblings are still running*.
-- The live poll surfaces this so the execution timeline can render a
-- two-segment bar (coloured processing portion + greyed wait portion)
-- per branch in real time, instead of all branches reading as "in
-- progress" until the slowest one finishes.
--
-- Rows are still deleted at batch end in the post-`Promise.allSettled`
-- loop — this column only carries state during the brief window
-- between branch finish and batch settle.
ALTER TABLE "ai_workflow_running_step"
  ADD COLUMN "completedAt" TIMESTAMP(3);
