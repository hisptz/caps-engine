import { z } from "zod";
import { dhis2RecipientsSchema, hasRecipients } from "@/shared/pipeline/notifications.ts";

export const dhis2NotifyConfigSchema = z
  .object({
    recipients: dhis2RecipientsSchema.default({ users: [], userGroups: [] }),
    /**
     * Message subject and body. `{{placeholders}}` are filled from the step context:
     * `{{stepName}}`, `{{executionId}}`, `{{date}}`, and `{{input.<field>}}` for any
     * field of the previous step's output (e.g. `{{input.imported}}` after DHIS2 Data Upload,
     * `{{input.jobId}}` after Prediction Poll).
     */
    subject: z.string().min(1).max(255).default("CAPS: {{stepName}} — run finished"),
    message: z
      .string()
      .min(1)
      .default("The CAPS pipeline run {{executionId}} reached step {{stepName}} on {{date}}."),
    /**
     * When false (default), a failed send is logged as a warning and the run continues —
     * the work before this step has already succeeded.
     */
    failOnError: z.boolean().default(false),
  })
  .refine((c) => hasRecipients(c.recipients), {
    message: "At least one user or user group recipient is required",
    path: ["recipients"],
  });

export type Dhis2NotifyConfig = z.infer<typeof dhis2NotifyConfigSchema>;
