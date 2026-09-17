-- Deleting a pipeline now removes its whole graph: steps, schedules, executions,
-- step executions, task executions, retry commands and logs. Previously every one
-- of these FKs restricted, so `DELETE /pipelines/:id` failed with a foreign key
-- violation for any pipeline that had steps.
--
-- `pipeline_executions.scheduleId` deliberately stays SET NULL: deleting a single
-- schedule must not erase the runs it fired. Those runs are removed via the
-- pipeline cascade instead.

ALTER TABLE "pipeline_steps" DROP CONSTRAINT "pipeline_steps_pipelineId_fkey";
ALTER TABLE "pipeline_steps" ADD CONSTRAINT "pipeline_steps_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pipeline_schedules" DROP CONSTRAINT "pipeline_schedules_pipelineId_fkey";
ALTER TABLE "pipeline_schedules" ADD CONSTRAINT "pipeline_schedules_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pipeline_executions" DROP CONSTRAINT "pipeline_executions_pipelineId_fkey";
ALTER TABLE "pipeline_executions" ADD CONSTRAINT "pipeline_executions_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "step_executions" DROP CONSTRAINT "step_executions_executionId_fkey";
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "pipeline_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "step_executions" DROP CONSTRAINT "step_executions_stepId_fkey";
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "pipeline_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_executions" DROP CONSTRAINT "task_executions_stepExecutionId_fkey";
ALTER TABLE "task_executions" ADD CONSTRAINT "task_executions_stepExecutionId_fkey" FOREIGN KEY ("stepExecutionId") REFERENCES "step_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "step_retry_commands" DROP CONSTRAINT "step_retry_commands_executionId_fkey";
ALTER TABLE "step_retry_commands" ADD CONSTRAINT "step_retry_commands_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "pipeline_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "step_retry_commands" DROP CONSTRAINT "step_retry_commands_sourceStepExecutionId_fkey";
ALTER TABLE "step_retry_commands" ADD CONSTRAINT "step_retry_commands_sourceStepExecutionId_fkey" FOREIGN KEY ("sourceStepExecutionId") REFERENCES "step_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "step_retry_commands" DROP CONSTRAINT "step_retry_commands_replacementStepExecutionId_fkey";
ALTER TABLE "step_retry_commands" ADD CONSTRAINT "step_retry_commands_replacementStepExecutionId_fkey" FOREIGN KEY ("replacementStepExecutionId") REFERENCES "step_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "execution_logs" DROP CONSTRAINT "execution_logs_executionId_fkey";
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "pipeline_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "execution_logs" DROP CONSTRAINT "execution_logs_stepExecutionId_fkey";
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_stepExecutionId_fkey" FOREIGN KEY ("stepExecutionId") REFERENCES "step_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "execution_logs" DROP CONSTRAINT "execution_logs_taskExecutionId_fkey";
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_taskExecutionId_fkey" FOREIGN KEY ("taskExecutionId") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
