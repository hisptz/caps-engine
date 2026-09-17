-- Backfill pipeline_schedules from legacy pipeline-level cron expressions
INSERT INTO "pipeline_schedules" (
    "id",
    "pipelineId",
    "name",
    "type",
    "status",
    "cronExpr",
    "inputContext",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    p."id",
    'Default schedule',
    'CRON'::"ScheduleType",
    'ACTIVE'::"ScheduleStatus",
    p."cronExpression",
    '{}'::jsonb,
    NOW(),
    NOW()
FROM "pipelines" p
WHERE p."cronExpression" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "pipeline_schedules" s
    WHERE s."pipelineId" = p."id"
  );

-- Drop legacy pipeline-level scheduling columns
ALTER TABLE "pipelines" DROP COLUMN IF EXISTS "cronExpression",
DROP COLUMN IF EXISTS "timezone",
DROP COLUMN IF EXISTS "lastScheduledAt";
