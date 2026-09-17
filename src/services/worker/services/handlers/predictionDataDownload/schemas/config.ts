import { z } from "zod";

/**
 * Maps CHAP prediction-entry quantiles (string keys, e.g. `"0.5"`) to DHIS2 data element UIDs.
 */
export const predictionDataDownloadConfigSchema = z.object({
  dataElementIds: z.record(z.string(), z.string().min(1)).refine((o) => Object.keys(o).length > 0, {
    message: "dataElementIds must contain at least one CHAP dataElement → DHIS2 UID mapping",
  }),
});

export type PredictionDataDownloadConfig = z.infer<typeof predictionDataDownloadConfigSchema>;
