import { HANDLERS } from "@/services/worker/constants/handlers.ts";

export const EXCHANGES = {
  DLX: "caps.dlx",
} as const;

export const QUEUES = {
  PIPELINE_EXECUTIONS: "pipeline.executions",
  STEP_RESULTS: "pipeline.step-results",
  DEAD_LETTERS: "caps.dead-letters",
  STEP: HANDLERS,
} as const;
