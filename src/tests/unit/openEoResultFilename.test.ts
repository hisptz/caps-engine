import { describe, it, expect } from "vitest";
import { resolveResultFilename } from "@/shared/clients/openeo.ts";

describe("resolveResultFilename", () => {
  it("takes the result asset of a named export, not its manifest", () => {
    const results = {
      assets: {
        result: { href: "/jobs/job-1/results/export-2300ff9a.json", roles: ["data"] },
        manifest: {
          href: "/jobs/job-1/results/export-2300ff9a.manifest.json",
          roles: ["metadata"],
        },
      },
    };
    expect(resolveResultFilename(results)).toBe("export-2300ff9a.json");
  });

  it("falls back to the first data asset", () => {
    const results = { assets: { "result.dhis2.json": { roles: ["data"] } } };
    expect(resolveResultFilename(results)).toBe("result.dhis2.json");
  });

  it("fails when the job has no data asset", () => {
    expect(() => resolveResultFilename({ assets: {} })).toThrow("no data asset");
  });
});
