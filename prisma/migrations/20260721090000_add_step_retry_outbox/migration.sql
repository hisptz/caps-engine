-- CreateEnum
CREATE TYPE "StepAttemptKind" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "StepRetryCommandStatus" AS ENUM ('PENDING', 'DISPATCHED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxDeliveryStatus" AS ENUM ('PENDING', 'LEASED', 'PUBLISHED', 'FAILED');

-- AlterTable: StepExecution new columns
ALTER TABLE "step_executions" ADD COLUMN "attemptKind" "StepAttemptKind" NOT NULL DEFAULT 'AUTOMATIC';
ALTER TABLE "step_executions" ADD COLUMN "stepSnapshot" JSONB;
ALTER TABLE "step_executions" ADD COLUMN "resultProcessedAt" TIMESTAMP(3);

-- Preflight: renumber attempts so (executionId, stepId, attemptNumber) is unique
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "executionId", "stepId"
      ORDER BY "attemptNumber" ASC, "createdAt" ASC, id ASC
    ) AS new_attempt
  FROM "step_executions"
)
UPDATE "step_executions" AS se
SET "attemptNumber" = ranked.new_attempt
FROM ranked
WHERE se.id = ranked.id
  AND se."attemptNumber" <> ranked.new_attempt;

-- CreateIndex / UniqueConstraint
CREATE UNIQUE INDEX "step_executions_executionId_stepId_attemptNumber_key"
  ON "step_executions"("executionId", "stepId", "attemptNumber");

-- CreateTable: step_retry_commands
CREATE TABLE "step_retry_commands" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "sourceStepExecutionId" UUID NOT NULL,
    "replacementStepExecutionId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "StepRetryCommandStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "step_retry_commands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "step_retry_commands_idempotencyKey_key" ON "step_retry_commands"("idempotencyKey");
CREATE UNIQUE INDEX "step_retry_commands_sourceStepExecutionId_key" ON "step_retry_commands"("sourceStepExecutionId");
CREATE UNIQUE INDEX "step_retry_commands_replacementStepExecutionId_key" ON "step_retry_commands"("replacementStepExecutionId");
CREATE INDEX "step_retry_commands_executionId_idx" ON "step_retry_commands"("executionId");

ALTER TABLE "step_retry_commands"
  ADD CONSTRAINT "step_retry_commands_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "pipeline_executions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "step_retry_commands"
  ADD CONSTRAINT "step_retry_commands_sourceStepExecutionId_fkey"
  FOREIGN KEY ("sourceStepExecutionId") REFERENCES "step_executions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "step_retry_commands"
  ADD CONSTRAINT "step_retry_commands_replacementStepExecutionId_fkey"
  FOREIGN KEY ("replacementStepExecutionId") REFERENCES "step_executions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: outbox_messages
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "destination" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "leaseOwner" TEXT,
    "leasedAt" TIMESTAMP(3),
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbox_messages_status_availableAt_idx" ON "outbox_messages"("status", "availableAt");
