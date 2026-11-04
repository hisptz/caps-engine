-- Workflows: a frame around pipelines with its own start. A pipeline belongs to at most one
-- workflow; every execution a workflow run leads to carries that run's id.

-- AlterTable
ALTER TABLE "pipeline_executions" ADD COLUMN     "workflowRunId" UUID;

-- AlterTable
ALTER TABLE "pipelines" ADD COLUMN     "workflowId" UUID;

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "cronExpr" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "skipped" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflows_name_key" ON "workflows"("name");

-- CreateIndex
CREATE INDEX "workflow_runs_workflowId_createdAt_idx" ON "workflow_runs"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "pipeline_executions_workflowRunId_idx" ON "pipeline_executions"("workflowRunId");

-- CreateIndex
CREATE INDEX "pipelines_workflowId_idx" ON "pipelines"("workflowId");

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_executions" ADD CONSTRAINT "pipeline_executions_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Wake the scheduler when a workflow's schedule or active flag changes (same channel as pipeline schedules)
CREATE TRIGGER workflows_caps_schedule_events
  AFTER INSERT OR UPDATE OF "cronExpr", "isActive" OR DELETE ON "workflows"
  FOR EACH ROW
  EXECUTE FUNCTION notify_caps_schedule_event();
