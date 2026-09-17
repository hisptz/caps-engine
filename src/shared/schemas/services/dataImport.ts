import { z } from "zod";

export const dataImportConfigSchema = z.object({
  filename: z.string(),
});
