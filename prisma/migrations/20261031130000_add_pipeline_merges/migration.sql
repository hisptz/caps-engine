-- Merges: inside a workflow run, wait for several pipelines, then start one more.
-- A merge run collects one arrival per source and decides once (fired, failed, timed out, …).

-- CreateEnum
CREATE TYPE "MergeTriggerRule" AS ENUM ('ALL_SUCCEEDED', 'ALL_DONE');

-- CreateEnum
CREATE TYPE "MergeRunStatus" AS ENUM ('WAITING', 'FIRED', 'NOT_MET', 'SKIPPED', 'FAILED', 'TIMED_OUT', 'CANCELLED');

-- CreateTable
CREATE TABLE "pipeline_merges" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "workflowId" UUID NOT NULL,
    "targetPipelineId" UUID NOT NULL,
    "triggerRule" "MergeTriggerRule" NOT NULL DEFAULT 'ALL_SUCCEEDED',
    "timeoutMinutes" INTEGER NOT NULL DEFAULT 1440,
    "condition" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_sources" (
    "mergeId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,

    CONSTRAINT "merge_sources_pkey" PRIMARY KEY ("mergeId","pipelineId")
);

-- CreateTable
CREATE TABLE "merge_runs" (
    "id" UUID NOT NULL,
    "mergeId" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "status" "MergeRunStatus" NOT NULL DEFAULT 'WAITING',
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "evaluatedAt" TIMESTAMP(3),
    "targetExecutionId" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merge_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_arrivals" (
    "mergeRunId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "status" "PipelineExecutionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merge_arrivals_pkey" PRIMARY KEY ("mergeRunId","pipelineId")
);

-- CreateIndex
CREATE INDEX "pipeline_merges_workflowId_idx" ON "pipeline_merges"("workflowId");

-- CreateIndex
CREATE INDEX "pipeline_merges_targetPipelineId_idx" ON "pipeline_merges"("targetPipelineId");

-- CreateIndex
CREATE INDEX "merge_sources_pipelineId_idx" ON "merge_sources"("pipelineId");

-- CreateIndex
CREATE UNIQUE INDEX "merge_runs_targetExecutionId_key" ON "merge_runs"("targetExecutionId");

-- CreateIndex
CREATE INDEX "merge_runs_status_deadlineAt_idx" ON "merge_runs"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "merge_runs_workflowRunId_idx" ON "merge_runs"("workflowRunId");

-- CreateIndex
CREATE UNIQUE INDEX "merge_runs_mergeId_workflowRunId_key" ON "merge_runs"("mergeId", "workflowRunId");

-- AddForeignKey
ALTER TABLE "pipeline_merges" ADD CONSTRAINT "pipeline_merges_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_merges" ADD CONSTRAINT "pipeline_merges_targetPipelineId_fkey" FOREIGN KEY ("targetPipelineId") REFERENCES "pipelines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_sources" ADD CONSTRAINT "merge_sources_mergeId_fkey" FOREIGN KEY ("mergeId") REFERENCES "pipeline_merges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_sources" ADD CONSTRAINT "merge_sources_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_runs" ADD CONSTRAINT "merge_runs_mergeId_fkey" FOREIGN KEY ("mergeId") REFERENCES "pipeline_merges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_runs" ADD CONSTRAINT "merge_runs_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_runs" ADD CONSTRAINT "merge_runs_targetExecutionId_fkey" FOREIGN KEY ("targetExecutionId") REFERENCES "pipeline_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_arrivals" ADD CONSTRAINT "merge_arrivals_mergeRunId_fkey" FOREIGN KEY ("mergeRunId") REFERENCES "merge_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_arrivals" ADD CONSTRAINT "merge_arrivals_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "pipeline_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

