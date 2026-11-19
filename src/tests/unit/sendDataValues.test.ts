import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockContext, buildMockTaskHandle } from "@/tests/utils/helpers.ts";

const mockPost = vi.fn();
vi.mock("@/shared/clients/dhis.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/clients/dhis.ts")>()),
  createRouteClient: vi.fn(() => ({ post: mockPost })),
}));

import { createRouteClient } from "@/shared/clients/dhis.ts";
import type { DataValue } from "@/services/worker/types/data.ts";
import { StepPermanentError } from "@/services/worker/types/service.ts";
import { sendDataValues } from "@/services/worker/utils/sendDataValues.ts";
import { StepError } from "@/shared/utils/error.ts";

const ROUTE = "caps-src-target";

function values(count: number): DataValue[] {
  return Array.from({ length: count }, (_, i) => ({
    dataElement: "fbfJHSPpUQD",
    period: "202610",
    orgUnit: `OrgUnit${String(i).padStart(4, "0")}`,
    value: String(i),
  }));
}

function summary(status: string, counts: Partial<Record<string, number>> = {}, extra = {}) {
  return {
    status: 200,
    data: {
      status,
      importCount: { imported: 0, updated: 0, ignored: 0, deleted: 0, ...counts },
      ...extra,
    },
  };
}

function contextWithTasks() {
  const tasks = [buildMockTaskHandle(), buildMockTaskHandle(), buildMockTaskHandle()];
  let next = 0;
  const startTask = vi.fn(async () => tasks[next++]!);
  return { ctx: buildMockContext({ tasks: { startTask } }), tasks, startTask };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendDataValues", () => {
  it("posts the values through the route in chunks and adds up DHIS2's counts", async () => {
    mockPost
      .mockResolvedValueOnce(summary("SUCCESS", { imported: 2 }))
      .mockResolvedValueOnce(summary("SUCCESS", { imported: 1, updated: 1 }))
      .mockResolvedValueOnce(summary("SUCCESS", { ignored: 1 }));
    const { ctx, tasks, startTask } = contextWithTasks();

    const result = await sendDataValues(ctx, {
      routeCode: ROUTE,
      dataValues: values(5),
      importStrategy: "CREATE",
      chunkSize: 2,
      taskName: "upload-chunk",
    });

    expect(createRouteClient).toHaveBeenCalledWith(ROUTE);
    expect(mockPost).toHaveBeenCalledTimes(3);
    const [path, body, options] = mockPost.mock.calls[0]!;
    expect(path).toBe("/dataValueSets");
    expect(body.dataValues).toHaveLength(2);
    expect(options).toEqual({ params: { importStrategy: "CREATE" } });
    expect(mockPost.mock.calls[2]![1].dataValues).toHaveLength(1);

    expect(startTask).toHaveBeenCalledWith("upload-chunk", { chunk: "1/3", values: 2 });
    expect(tasks.every((task) => vi.mocked(task.succeed).mock.calls.length === 1)).toBe(true);
    expect(result).toEqual({
      status: "SUCCESS",
      imported: 3,
      updated: 1,
      ignored: 1,
      deleted: 0,
      conflicts: 0,
      chunks: 3,
    });
    expect(ctx.log).not.toHaveBeenCalled();
  });

  it("reads the import summary from DHIS2's web message wrapper", async () => {
    mockPost.mockResolvedValueOnce({
      status: 200,
      data: {
        httpStatus: "OK",
        response: {
          status: "SUCCESS",
          importCount: { imported: 4, updated: 0, ignored: 0, deleted: 0 },
        },
      },
    });
    const result = await sendDataValues(buildMockContext(), {
      routeCode: ROUTE,
      dataValues: values(4),
    });
    expect(result).toMatchObject({ status: "SUCCESS", imported: 4, chunks: 1 });
    expect(mockPost.mock.calls[0]![2]).toEqual({ params: { importStrategy: "CREATE_AND_UPDATE" } });
  });

  it("keeps a WARNING status and logs the conflicts once, grouped", async () => {
    const conflict = { object: "fbfJHSPpUQD", value: "Period is locked" };
    mockPost
      .mockResolvedValueOnce(
        summary("WARNING", { imported: 1, ignored: 1 }, { conflicts: [conflict] })
      )
      .mockResolvedValueOnce(summary("SUCCESS", { imported: 2 }));
    const { ctx } = contextWithTasks();

    const result = await sendDataValues(ctx, {
      routeCode: ROUTE,
      dataValues: values(4),
      chunkSize: 2,
    });

    expect(result).toMatchObject({ status: "WARNING", imported: 3, ignored: 1, conflicts: 1 });
    expect(ctx.log).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      "The target instance imported the values with conflicts",
      expect.objectContaining({
        routeCode: ROUTE,
        totalConflicts: 1,
        conflicts: [{ value: "Period is locked", count: 1, objects: ["fbfJHSPpUQD"] }],
      })
    );
  });

  it("fails on a chunk DHIS2 rejects, says how many were stored, and stops", async () => {
    mockPost.mockResolvedValueOnce(summary("SUCCESS", { imported: 2 })).mockResolvedValueOnce(
      summary(
        "ERROR",
        {},
        {
          description: "Import failed",
          conflicts: [{ object: "fbfJHSPpUQD", value: "Data element not in a data set" }],
        }
      )
    );
    const { ctx, tasks } = contextWithTasks();

    const error = await sendDataValues(ctx, {
      routeCode: ROUTE,
      dataValues: values(6),
      chunkSize: 2,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toBe("The target instance rejected the data value import");
    expect((error as StepError).details).toMatchObject({
      routeCode: ROUTE,
      chunk: "2/3",
      chunksStored: 1,
      totalConflicts: 1,
    });
    expect(tasks[1]!.fail).toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it("describes a route that can't be reached, and leaves the step retryable", async () => {
    mockPost.mockRejectedValueOnce(
      new AxiosError("Forbidden", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 403,
      } as never)
    );
    const { ctx, tasks } = contextWithTasks();

    const error = await sendDataValues(ctx, { routeCode: ROUTE, dataValues: values(1) }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(StepError);
    expect(error).not.toBeInstanceOf(StepPermanentError);
    expect((error as StepError).details).toMatchObject({ source: "dhis2-route", chunk: "1/1" });
    expect(String((error as StepError).details.description)).toContain(`Route "${ROUTE}"`);
    expect(tasks[0]!.fail).toHaveBeenCalled();
  });

  it("treats DHIS2's 409 answer as an import summary", async () => {
    mockPost.mockRejectedValueOnce(
      new AxiosError("Conflict", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 409,
        data: { status: "ERROR", description: "All values rejected" },
      } as never)
    );

    await expect(
      sendDataValues(buildMockContext(), { routeCode: ROUTE, dataValues: values(1) })
    ).rejects.toThrow("The target instance rejected the data value import");
  });

  it("sends nothing when there are no values", async () => {
    const ctx = buildMockContext();
    const result = await sendDataValues(ctx, { routeCode: ROUTE, dataValues: [] });
    expect(mockPost).not.toHaveBeenCalled();
    expect(ctx.tasks.startTask).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "SUCCESS",
      imported: 0,
      updated: 0,
      ignored: 0,
      deleted: 0,
      conflicts: 0,
      chunks: 0,
    });
  });

  it("refuses a chunk size that isn't a positive whole number", async () => {
    await expect(
      sendDataValues(buildMockContext(), { routeCode: ROUTE, dataValues: values(1), chunkSize: 0 })
    ).rejects.toThrow("chunkSize");
  });
});
