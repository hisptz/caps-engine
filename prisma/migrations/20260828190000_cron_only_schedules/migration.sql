-- Remove INTERVAL / ONE_TIME schedules and rows without a cron expression
DELETE FROM "pipeline_schedules"
WHERE "type" <> 'CRON' OR "cronExpr" IS NULL;

-- ONE_TIME leftover status is no longer a valid schedule state
UPDATE "pipeline_schedules"
SET "status" = 'PAUSED'
WHERE "status" = 'EXPIRED';

-- Cron-only columns
ALTER TABLE "pipeline_schedules"
  DROP COLUMN "type",
  DROP COLUMN "intervalMs",
  DROP COLUMN "runAt",
  DROP COLUMN "expiresAt";

ALTER TABLE "pipeline_schedules"
  ALTER COLUMN "cronExpr" SET NOT NULL;

-- Recreate ScheduleStatus without EXPIRED
CREATE TYPE "ScheduleStatus_new" AS ENUM ('ACTIVE', 'PAUSED');

ALTER TABLE "pipeline_schedules" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "pipeline_schedules"
  ALTER COLUMN "status" TYPE "ScheduleStatus_new"
  USING ("status"::text::"ScheduleStatus_new");

DROP TYPE "ScheduleStatus";

ALTER TYPE "ScheduleStatus_new" RENAME TO "ScheduleStatus";

ALTER TABLE "pipeline_schedules"
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

DROP TYPE "ScheduleType";

-- Pipeline delete should drop schedules so LISTEN DELETE fires
ALTER TABLE "pipeline_schedules"
  DROP CONSTRAINT "pipeline_schedules_pipelineId_fkey";

ALTER TABLE "pipeline_schedules"
  ADD CONSTRAINT "pipeline_schedules_pipelineId_fkey"
  FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Notify the scheduler process of schedule / pipeline-active changes
CREATE OR REPLACE FUNCTION notify_caps_schedule_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec_id uuid;
BEGIN
  rec_id := COALESCE(NEW.id, OLD.id);

  PERFORM pg_notify(
    'caps_schedule_events',
    json_build_object(
      'table', TG_TABLE_NAME,
      'op', TG_OP,
      'id', rec_id
    )::text
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER pipeline_schedules_caps_schedule_events
  AFTER INSERT OR UPDATE OR DELETE ON "pipeline_schedules"
  FOR EACH ROW
  EXECUTE FUNCTION notify_caps_schedule_event();

CREATE TRIGGER pipelines_caps_schedule_events
  AFTER UPDATE OF "isActive" OR DELETE ON "pipelines"
  FOR EACH ROW
  EXECUTE FUNCTION notify_caps_schedule_event();
