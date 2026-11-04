-- Pipeline connectors: when a pipeline finishes, a connector may start another pipeline.
-- A connector run records each decision; the source execution is already finished by then.
-- Deleting a connector's target pipeline is restricted until the connector is removed.

-- CreateEnum
CREATE TYPE "ConnectorTriggerOn" AS ENUM ('COMPLETED', 'FAILED', 'FINISHED');

-- CreateEnum
CREATE TYPE "ConnectorRunStatus" AS ENUM ('WAITING', 'FIRED', 'NOT_MET', 'SKIPPED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "pipeline_executions" ADD COLUMN     "chainDepth" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "pipeline_connectors" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sourcePipelineId" UUID NOT NULL,
    "targetPipelineId" UUID NOT NULL,
    "on" "ConnectorTriggerOn" NOT NULL DEFAULT 'COMPLETED',
    "condition" JSONB,
    "inputMapping" JSONB NOT NULL DEFAULT '{}',
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_runs" (
    "id" UUID NOT NULL,
    "connectorId" UUID NOT NULL,
    "sourceExecutionId" UUID NOT NULL,
    "targetExecutionId" UUID,
    "status" "ConnectorRunStatus" NOT NULL DEFAULT 'WAITING',
    "sourceStatus" "PipelineExecutionStatus" NOT NULL,
    "checkAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluatedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pipeline_connectors_sourcePipelineId_idx" ON "pipeline_connectors"("sourcePipelineId");

-- CreateIndex
CREATE INDEX "pipeline_connectors_targetPipelineId_idx" ON "pipeline_connectors"("targetPipelineId");

-- CreateIndex
CREATE UNIQUE INDEX "connector_runs_targetExecutionId_key" ON "connector_runs"("targetExecutionId");

-- CreateIndex
CREATE INDEX "connector_runs_status_checkAt_idx" ON "connector_runs"("status", "checkAt");

-- CreateIndex
CREATE INDEX "connector_runs_sourceExecutionId_idx" ON "connector_runs"("sourceExecutionId");

-- CreateIndex
CREATE UNIQUE INDEX "connector_runs_connectorId_sourceExecutionId_key" ON "connector_runs"("connectorId", "sourceExecutionId");

-- AddForeignKey
ALTER TABLE "pipeline_connectors" ADD CONSTRAINT "pipeline_connectors_sourcePipelineId_fkey" FOREIGN KEY ("sourcePipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_connectors" ADD CONSTRAINT "pipeline_connectors_targetPipelineId_fkey" FOREIGN KEY ("targetPipelineId") REFERENCES "pipelines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "pipeline_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_sourceExecutionId_fkey" FOREIGN KEY ("sourceExecutionId") REFERENCES "pipeline_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_targetExecutionId_fkey" FOREIGN KEY ("targetExecutionId") REFERENCES "pipeline_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

