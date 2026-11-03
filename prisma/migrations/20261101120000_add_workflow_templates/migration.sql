-- Workflow templates: a workflow remembers the template and parameters it was created from,
-- and a workflow run may cover a fixed range of periods (e.g. a backfill).

-- AlterTable
ALTER TABLE "workflows" ADD COLUMN     "template" TEXT,
ADD COLUMN     "templateParams" JSONB,
ADD COLUMN     "templateState" JSONB;

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "period" JSONB;
