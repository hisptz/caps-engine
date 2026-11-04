import { z } from "zod";
import { ConnectorRunStatus, ConnectorTriggerOn } from "@db/client";
import { validateRule } from "@/shared/pipeline/rules.ts";
import { validateTargetPath } from "@/shared/pipeline/connectors.ts";

export const idParams = z.object({ id: z.uuid("Invalid connector ID") });
export const connectorRunIdParams = z.object({ id: z.uuid("Invalid connector run ID") });

/** Longest delay a connector may wait before evaluating its rule (7 days). */
export const MAX_CONNECTOR_DELAY_MINUTES = 7 * 24 * 60;

const conditionSchema = z
  .unknown()
  .nullable()
  .superRefine((rule, ctx) => {
    const error = rule === null || rule === undefined ? null : validateRule(rule);
    if (error) {
      ctx.addIssue({ code: "custom", message: error });
    }
  });

const inputMappingSchema = z.record(
  z
    .string()
    .min(1, "Target context path must not be empty")
    .superRefine((path, ctx) => {
      const error = validateTargetPath(path);
      if (error) {
        ctx.addIssue({ code: "custom", message: error });
      }
    }),
  z.string().min(1, "Source context path must not be empty")
);

export const listConnectorsQuery = z.object({
  /** Connectors where this pipeline is the source or the target */
  pipelineId: z.uuid("Invalid pipeline ID").optional(),
});

export const createConnectorBody = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    sourcePipelineId: z.uuid("Invalid source pipeline ID"),
    targetPipelineId: z.uuid("Invalid target pipeline ID"),
    otherwisePipelineId: z.uuid("Invalid otherwise pipeline ID").nullable().optional(),
    on: z.enum(ConnectorTriggerOn).default(ConnectorTriggerOn.COMPLETED),
    condition: conditionSchema.optional(),
    inputMapping: inputMappingSchema.default({}),
    delayMinutes: z.number().int().min(0).max(MAX_CONNECTOR_DELAY_MINUTES).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateConnectorBody = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().nullable().optional(),
    targetPipelineId: z.uuid("Invalid target pipeline ID").optional(),
    otherwisePipelineId: z.uuid("Invalid otherwise pipeline ID").nullable().optional(),
    on: z.enum(ConnectorTriggerOn).optional(),
    condition: conditionSchema.optional(),
    inputMapping: inputMappingSchema.optional(),
    delayMinutes: z.number().int().min(0).max(MAX_CONNECTOR_DELAY_MINUTES).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const listConnectorRunsQuery = z.object({
  status: z.enum(ConnectorRunStatus).optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

export type ListConnectorsQuery = z.infer<typeof listConnectorsQuery>;
export type CreateConnectorBody = z.infer<typeof createConnectorBody>;
export type UpdateConnectorBody = z.infer<typeof updateConnectorBody>;
export type ListConnectorRunsQuery = z.infer<typeof listConnectorRunsQuery>;
