import { Elysia } from "elysia";
import { MonitoringService } from "@/services/api/modules/monitoring/service.ts";
import {
  idParams,
  executionDetailParams,
  stepAttemptsParams,
  stepExecutionIdParams,
  taskExecutionIdParams,
  listExecutionsQuery,
  listDeadLettersQuery,
  replayDeadLetterBody,
  triggerPipelineBody,
  retryStepExecutionBody,
  durationsQuery,
  topErrorsQuery,
  topFailingStepsQuery,
  trendsQuery,
} from "@/services/api/modules/monitoring/model.ts";

const monitoringService = new MonitoringService();

export const monitoringModule = new Elysia({ prefix: "/monitoring" })
  .get("/dashboard", () => monitoringService.getDashboardSummary(), {
    detail: {
      summary: "Dashboard summary",
      description: "Live system health: execution counts, stuck pipelines, and recent failures",
      tags: ["Operator"],
      operationId: "getDashboardSummary",
      responses: { "200": { description: "Dashboard snapshot" } },
    },
  })
  .get("/execution", ({ query }) => monitoringService.listExecutions(query), {
    query: listExecutionsQuery,
    detail: {
      summary: "List executions",
      description:
        "Paginated list of pipeline executions, optionally filtered by pipeline or status",
      tags: ["Operator"],
      operationId: "listExecutions",
      responses: {
        "200": { description: "Paginated execution list" },
        "400": { description: "Invalid query parameters" },
      },
    },
  })
  .get("/execution/:id", ({ params }) => monitoringService.getExecutionDetail(params.id), {
    params: executionDetailParams,
    detail: {
      summary: "Get execution detail",
      description: "Full drill-down for a single pipeline run including steps, tasks, and logs",
      tags: ["Developer"],
      operationId: "getExecutionDetail",
      responses: {
        "200": { description: "Execution detail with nested steps and logs" },
        "404": { description: "Execution not found" },
      },
    },
  })
  .get(
    "/execution/:id/steps/:stepId/attempts",
    ({ params }) => monitoringService.getStepAttempts(params.id, params.stepId),
    {
      params: stepAttemptsParams,
      detail: {
        summary: "Get step attempts",
        description: "All retry attempts for a given step within a pipeline execution",
        tags: ["Developer"],
        operationId: "getStepAttempts",
        responses: { "200": { description: "List of step execution attempts with task details" } },
      },
    }
  )
  .get("/dead-letters", ({ query }) => monitoringService.listDeadLetters(query), {
    query: listDeadLettersQuery,
    detail: {
      summary: "List dead letter events",
      tags: ["Dead Letters"],
      operationId: "listDeadLetters",
      responses: {
        "200": { description: "Paginated dead letter log entries" },
        "400": { description: "Invalid query parameters" },
      },
    },
  })
  .post("/dead-letters/replay", ({ body }) => monitoringService.replayDeadLetter(body), {
    body: replayDeadLetterBody,
    detail: {
      summary: "Replay dead letter",
      tags: ["Dead Letters"],
      operationId: "replayDeadLetter",
      responses: {
        "200": { description: "Message replayed successfully" },
        "400": { description: "Invalid target queue or request body" },
      },
    },
  })
  .post("/executions/:id/cancel", ({ params }) => monitoringService.cancelExecution(params.id), {
    params: idParams,
    detail: {
      summary: "Cancel execution",
      tags: ["Operator"],
      operationId: "cancelExecution",
      responses: {
        "200": { description: "Execution cancelled" },
        "400": { description: "Execution is already in a terminal state" },
        "404": { description: "Execution not found" },
      },
    },
  })
  .post("/executions/:id/pause", ({ params }) => monitoringService.pauseExecution(params.id), {
    params: idParams,
    detail: {
      summary: "Pause execution",
      description:
        "Pause a PENDING or RUNNING execution. Cannot pause executions that are AWAITING_STEP (step already dispatched to a worker).",
      tags: ["Operator"],
      operationId: "pauseExecution",
      responses: {
        "200": { description: "Execution paused" },
        "400": { description: "Execution cannot be paused (wrong state)" },
        "404": { description: "Execution not found" },
      },
    },
  })
  .post("/executions/:id/resume", ({ params }) => monitoringService.resumeExecution(params.id), {
    params: idParams,
    detail: {
      summary: "Resume execution",
      description:
        "Resume a PAUSED execution. Sets status back to RUNNING and re-enqueues the execution for the coordinator via the durable outbox.",
      tags: ["Operator"],
      operationId: "resumeExecution",
      responses: {
        "200": { description: "Execution resumed" },
        "400": { description: "Execution is not paused" },
        "404": { description: "Execution not found" },
      },
    },
  })
  .post(
    "/pipelines/:id/trigger",
    ({ params, body }) => monitoringService.triggerPipeline(params.id, body),
    {
      params: idParams,
      body: triggerPipelineBody,
      detail: {
        summary: "Trigger pipeline",
        tags: ["Triggers"],
        operationId: "triggerPipeline",
        responses: {
          "200": { description: "Trigger result" },
          "400": { description: "Pipeline skipped due to concurrency policy" },
          "404": { description: "Pipeline not found" },
        },
      },
    }
  )
  .post(
    "/pipelines/:id/cancel",
    ({ params }) => monitoringService.cancelPipelineExecutions(params.id),
    {
      params: idParams,
      detail: {
        summary: "Cancel active executions",
        tags: ["Triggers"],
        operationId: "cancelPipelineExecutions",
        responses: {
          "200": { description: "Cancellation result" },
          "404": { description: "Pipeline not found" },
        },
      },
    }
  )
  .get(
    "/step-executions/:id",
    ({ params }) => monitoringService.getStepExecutionDetail(params.id),
    {
      params: stepExecutionIdParams,
      detail: {
        summary: "Get step execution detail",
        description: "Full detail for a single step execution including task executions and logs",
        tags: ["Developer"],
        operationId: "getStepExecutionDetail",
        responses: {
          "200": { description: "Step execution detail with tasks and logs" },
          "404": { description: "Step execution not found" },
        },
      },
    }
  )
  .get(
    "/step-executions/:id/logs",
    ({ params }) => monitoringService.getStepExecutionLogs(params.id),
    {
      params: stepExecutionIdParams,
      detail: {
        summary: "Get step execution logs",
        description:
          "All log entries for a specific step attempt, interleaved with task-level logs",
        tags: ["Developer"],
        operationId: "getStepExecutionLogs",
        responses: { "200": { description: "Ordered list of log entries" } },
      },
    }
  )
  .post(
    "/step-executions/:id/retry",
    ({ params, body, set }) => {
      set.status = 202;
      return monitoringService.retryStepExecution(params.id, body);
    },
    {
      params: stepExecutionIdParams,
      body: retryStepExecutionBody,
      detail: {
        summary: "Retry a failed step execution",
        description:
          "Resume the same pipeline execution from its current failed step by creating exactly one new MANUAL attempt. Requires an idempotency key. Preserves context, cursor, and attempt history. Uses the original step definition snapshot.",
        tags: ["Operator"],
        operationId: "retryStepExecution",
        responses: {
          "202": { description: "Retry accepted" },
          "404": { description: "Step execution not found" },
          "409": { description: "Step execution is not retryable or conflict" },
        },
      },
    }
  )
  .get(
    "/task-executions/:id",
    ({ params }) => monitoringService.getTaskExecutionDetail(params.id),
    {
      params: taskExecutionIdParams,
      detail: {
        summary: "Get task execution detail",
        description: "Full detail for a single task execution including its logs",
        tags: ["Developer"],
        operationId: "getTaskExecutionDetail",
        responses: {
          "200": { description: "Task execution detail with logs" },
          "404": { description: "Task execution not found" },
        },
      },
    }
  )
  .get(
    "/task-executions/:id/logs",
    ({ params }) => monitoringService.getTaskExecutionLogs(params.id),
    {
      params: taskExecutionIdParams,
      detail: {
        summary: "Get task execution logs",
        description: "All log entries for a specific task execution",
        tags: ["Developer"],
        operationId: "getTaskExecutionLogs",
        responses: { "200": { description: "Ordered list of log entries for the task execution" } },
      },
    }
  )
  .get("/analytics/durations", ({ query }) => monitoringService.getPipelineDurations(query.days), {
    query: durationsQuery,
    detail: {
      summary: "Pipeline durations",
      description: "Average and p95 pipeline duration per pipeline type over a date range",
      tags: ["Reporter"],
      operationId: "getPipelineDurations",
      responses: {
        "200": { description: "Duration statistics per pipeline" },
        "400": { description: "Invalid query parameters" },
      },
    },
  })
  .get(
    "/analytics/top-errors",
    ({ query }) => monitoringService.getTopErrors(query.days, query.limit),
    {
      query: topErrorsQuery,
      detail: {
        summary: "Top error messages",
        description: "Most frequently occurring error messages across all failed step executions",
        tags: ["Reporter"],
        operationId: "getTopErrors",
        responses: {
          "200": { description: "Ranked list of error messages with occurrence counts" },
          "400": { description: "Invalid query parameters" },
        },
      },
    }
  )
  .get(
    "/analytics/top-failing-steps",
    ({ query }) => monitoringService.getTopFailingSteps(query.days, query.limit),
    {
      query: topFailingStepsQuery,
      detail: {
        summary: "Top failing steps",
        description: "Steps that fail most frequently, with average attempt counts",
        tags: ["Reporter"],
        operationId: "getTopFailingSteps",
        responses: {
          "200": { description: "Ranked list of failing steps" },
          "400": { description: "Invalid query parameters" },
        },
      },
    }
  )
  .get(
    "/analytics/trends",
    ({ query }) => monitoringService.getDailyTrends(query.days, query.pipelineId),
    {
      query: trendsQuery,
      detail: {
        summary: "Daily execution trends",
        description: "Daily success and failure counts over a configurable date range",
        tags: ["Reporter"],
        operationId: "getDailyTrends",
        responses: {
          "200": { description: "Array of daily status counts" },
          "400": { description: "Invalid query parameters" },
        },
      },
    }
  );
