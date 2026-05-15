-- Live-trace fields for the execution detail page's running-step indicator.
-- Written alongside `currentStep` on every step_started transition; nulled
-- on every step termination (completion / failure / pause / cancel) and on
-- workflow finalisation. Lets the UI render the in-flight step's friendly
-- label and ticking elapsed time without parsing the workflow version
-- snapshot on each poll.
--
-- Nullable / no default — existing rows are unaffected; the engine starts
-- populating them on the next step transition after deploy.
ALTER TABLE "ai_workflow_execution" ADD COLUMN "currentStepLabel" TEXT;
ALTER TABLE "ai_workflow_execution" ADD COLUMN "currentStepType" TEXT;
ALTER TABLE "ai_workflow_execution" ADD COLUMN "currentStepStartedAt" TIMESTAMP(3);
