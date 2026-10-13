-- Async climate-api jobs submitted through CAPS, so clients can rediscover running jobs.
CREATE TABLE "climate_jobs" (
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "datasetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "climate_jobs_pkey" PRIMARY KEY ("jobId")
);

CREATE INDEX "climate_jobs_status_idx" ON "climate_jobs"("status");
