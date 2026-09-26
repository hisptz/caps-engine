-- Structured failure context kept alongside the short errorMessage headline, so
-- long upstream errors (e.g. hundreds of DHIS2 conflicts) don't live in one string.
ALTER TABLE "step_executions" ADD COLUMN "errorDetails" JSONB;
ALTER TABLE "task_executions" ADD COLUMN "errorDetails" JSONB;
