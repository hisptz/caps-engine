import type { PrismaClient } from "@db/client";
import { startWorkflow, type StartWorkflowResult } from "@/shared/pipeline/workflows.ts";
import {
  startExecution,
  type StartExecutionOptions,
  type StartExecutionResult,
} from "@/shared/pipeline/startExecution.ts";

export type TriggerOptions = Omit<StartExecutionOptions, "triggeredBy" | "chainDepth"> & {
  triggeredBy: "scheduler" | "api" | "webhook";
};

export type TriggerResult = StartExecutionResult;

export class TriggerService {
  constructor(private prisma: PrismaClient) {}

  async triggerPipeline(pipelineId: string, opts: TriggerOptions): Promise<TriggerResult> {
    return startExecution(this.prisma, pipelineId, opts);
  }

  async triggerWorkflow(workflowId: string): Promise<StartWorkflowResult> {
    return startWorkflow(this.prisma, workflowId, { triggeredBy: "scheduler" });
  }
}
