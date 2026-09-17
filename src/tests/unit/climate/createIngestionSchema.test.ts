import { describe, it, expect } from "vitest";
import { createIngestionSchema } from "@/services/api/utils/climate/schemas/createIngestion.schema.ts";

describe("createIngestionSchema", () => {
  it("accepts a historical ingestion with start", () => {
    const parsed = createIngestionSchema.parse({
      dataset_id: "chirps3_precipitation_daily",
      start: "2024-01-01",
      end: "2024-12-31",
    });
    expect(parsed.start).toBe("2024-01-01");
    expect(parsed.end).toBe("2024-12-31");
  });

  it("accepts a forecast ingestion without start", () => {
    const parsed = createIngestionSchema.parse({
      dataset_id: "forecast_template",
    });
    expect(parsed.dataset_id).toBe("forecast_template");
    expect(parsed.start).toBeUndefined();
    expect(parsed.overwrite).toBe(false);
    expect(parsed.publish).toBe(true);
  });

  it("rejects an empty dataset_id", () => {
    const result = createIngestionSchema.safeParse({ dataset_id: "" });
    expect(result.success).toBe(false);
  });
});
