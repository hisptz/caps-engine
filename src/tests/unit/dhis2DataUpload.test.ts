import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext } from "@/tests/utils/helpers.ts";
import { stubBun } from "@/tests/utils/bun.ts";

vi.mock("@/services/worker/utils/dhis2.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/worker/utils/dhis2.ts")>();
  return {
    ...actual,
    postDataValueSet: vi.fn(),
  };
});

const mockFileJson = vi.fn();
const mockBunFile = vi.fn(() => ({ json: mockFileJson }));

import { postDataValueSet } from "@/services/worker/utils/dhis2.ts";
import { dhis2DataUpload } from "@/services/worker/services/handlers/dhis2DataUpload/index.ts";
import { StepSkippedError } from "@/services/worker/types/service.ts";

const mockPostDataValueSet = vi.mocked(postDataValueSet);

beforeEach(() => {
  vi.clearAllMocks();
  stubBun({ file: mockBunFile });
  mockFileJson.mockResolvedValue({ dataValues: [] });
});

describe("dhis2-data-upload with an empty file", () => {
  it("fails by default", async () => {
    const ctx = buildMockContext({ input: { filename: "empty.json" } });
    await expect(dhis2DataUpload.execute(ctx)).rejects.toThrow(/contains no dataValues/);
    expect(mockPostDataValueSet).not.toHaveBeenCalled();
  });

  it("is skipped when the previous step allows an empty file", async () => {
    const ctx = buildMockContext({ input: { filename: "empty.json", allowEmpty: true } });
    await expect(dhis2DataUpload.execute(ctx)).rejects.toThrow(StepSkippedError);
    expect(mockPostDataValueSet).not.toHaveBeenCalled();
  });

  it("still fails on a malformed file, even when empty files are allowed", async () => {
    mockFileJson.mockResolvedValue({});
    const ctx = buildMockContext({ input: { filename: "bad.json", allowEmpty: true } });
    await expect(dhis2DataUpload.execute(ctx)).rejects.toThrow(/contains no dataValues/);
  });
});
