-- Connector "otherwise": a second target started when the connector's rule is not met.
-- Deleting a pipeline a connector would start otherwise is restricted, like its main target.


-- AlterTable
ALTER TABLE "connector_runs" ADD COLUMN     "startedOtherwise" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "pipeline_connectors" ADD COLUMN     "otherwisePipelineId" UUID;

-- CreateIndex
CREATE INDEX "pipeline_connectors_otherwisePipelineId_idx" ON "pipeline_connectors"("otherwisePipelineId");

-- AddForeignKey
ALTER TABLE "pipeline_connectors" ADD CONSTRAINT "pipeline_connectors_otherwisePipelineId_fkey" FOREIGN KEY ("otherwisePipelineId") REFERENCES "pipelines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

