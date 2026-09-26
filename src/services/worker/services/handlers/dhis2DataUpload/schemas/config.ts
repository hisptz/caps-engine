import { z } from "zod";

/**
 * `importStrategy` query parameter for DHIS2 `POST /dataValueSets`.
 * - CREATE_AND_UPDATE (Merge): import new values and update existing
 * - CREATE (Append): import new values only
 * - UPDATE (Update): only update existing values, ignore new values
 */
export const dataValueImportStrategySchema = z.enum(["CREATE_AND_UPDATE", "CREATE", "UPDATE"]);

export type DataValueImportStrategy = z.infer<typeof dataValueImportStrategySchema>;

export const dhis2DataUploadConfigSchema = z.object({
  importStrategy: dataValueImportStrategySchema.default("CREATE_AND_UPDATE"),
});

export type Dhis2DataUploadConfig = z.infer<typeof dhis2DataUploadConfigSchema>;
