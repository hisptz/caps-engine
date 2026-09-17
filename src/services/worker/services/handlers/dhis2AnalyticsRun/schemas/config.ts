import { z } from "zod";

export const dhis2AnalyticsRunConfigSchema = z.object({
  /**
   * Trigger options for `POST /resourceTables/analytics`.
   * These are query parameters in the DHIS2 API.
   */
  runOptions: z
    .object({
      lastYears: z.number().int().nonnegative().optional(),
      skipAggregate: z.boolean().default(false),
      skipEnrollment: z.boolean().default(false),
      skipEvents: z.boolean().default(false),
      skipOrgUnitOwnership: z.boolean().default(false),
      skipOutliers: z.boolean().default(false),
      skipResourceTables: z.boolean().default(false),
      skipTrackedEntities: z.boolean().default(false),
      skipValidationResult: z.boolean().default(false),
    })
    .default({
      skipAggregate: false,
      skipEnrollment: false,
      skipEvents: false,
      skipOrgUnitOwnership: false,
      skipOutliers: false,
      skipResourceTables: false,
      skipTrackedEntities: false,
      skipValidationResult: false,
    }),

  /**
   * Polling controls for watching DHIS2 task completion.
   */
  polling: z
    .object({
      pollIntervalMs: z.number().int().min(250).default(5_000),
      maxAttempts: z.number().int().min(1).default(120),
    })
    .default({
      pollIntervalMs: 5_000,
      maxAttempts: 120,
    }),
});

export type Dhis2AnalyticsRunConfig = z.infer<typeof dhis2AnalyticsRunConfigSchema>;
