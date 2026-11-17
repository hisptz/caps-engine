import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMockContext } from "@/tests/utils/helpers.ts";
import { StepPermanentError, StepWaitingError } from "@/services/worker/types/service.ts";

vi.mock("@/shared/clients/ocsPipelines.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/clients/ocsPipelines.ts")>()),
  getOcsPipeline: vi.fn(),
  getOcsPipelineRun: vi.fn(),
  startOcsPipelineRun: vi.fn(),
}));

import {
  getOcsPipeline,
  getOcsPipelineRun,
  startOcsPipelineRun,
  type OcsPipeline,
  type OcsPipelineRun,
} from "@/shared/clients/ocsPipelines.ts";
import { ocsPipelineRun } from "@/services/worker/services/handlers/ocsPipelineRun/index.ts";

const mockGetPipeline = vi.mocked(getOcsPipeline);
const mockGetRun = vi.mocked(getOcsPipelineRun);
const mockStartRun = vi.mocked(startOcsPipelineRun);

const config = {
  pipelineId: "chirps-precip-district",
  period: { mode: "fixed", periodType: "monthly", id: "202501", endId: "202503" },
  mode: "live",
};

function pipeline(
  mode: "live" | "dry_run",
  policy: "manual" | "on_update" = "manual"
): OcsPipeline {
  return {
    spec: {
      id: "chirps-precip-district",
      workflow: { id: "aggregate_by_features", arguments: {} },
      destination: { plugin: "dhis2", settings: {} },
      delivery: { mode, policy },
    },
    revision: 1,
    created_at: "2026-11-17T00:00:00Z",
    approved: true,
    trigger: { policy, datasets: [] },
    inputs: [],
    workflow: { id: "aggregate_by_features", title: "Aggregate", arguments: {} },
    destination: { plugin: "dhis2", title: "DHIS2", settings: [] },
  };
}

function run(
  status: OcsPipelineRun["status"],
  extra: Partial<OcsPipelineRun> = {}
): OcsPipelineRun {
  return { run_id: "r1", status, mode: "live", start: "2025-01-01", end: "2025-03-31", ...extra };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the step to throw");
}

describe("ocs-pipeline-run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts a run over the step's period and waits for it", async () => {
    mockGetPipeline.mockResolvedValue(pipeline("live"));
    mockStartRun.mockResolvedValue(run("queued"));

    const error = await caught(ocsPipelineRun.execute(buildMockContext({ handlerConfig: config })));

    expect(mockStartRun).toHaveBeenCalledWith("chirps-precip-district", {
      start: "2025-01-01",
      end: "2025-03-31",
      mode: "live",
    });
    expect(error).toBeInstanceOf(StepWaitingError);
    expect((error as StepWaitingError).retryAfterMs).toBe(15_000);
    expect((error as StepWaitingError).state).toMatchObject({ runId: "r1", lastStatus: "queued" });
  });

  it("refuses a live run of a pipeline that is not live, without starting it", async () => {
    mockGetPipeline.mockResolvedValue(pipeline("dry_run"));

    const error = await caught(ocsPipelineRun.execute(buildMockContext({ handlerConfig: config })));

    expect(error).toBeInstanceOf(StepPermanentError);
    expect(mockStartRun).not.toHaveBeenCalled();
  });

  it("warns when OCS also starts the pipeline on dataset updates", async () => {
    mockGetPipeline.mockResolvedValue(pipeline("live", "on_update"));
    mockStartRun.mockResolvedValue(run("queued"));
    const ctx = buildMockContext({ handlerConfig: config });

    await caught(ocsPipelineRun.execute(ctx));

    expect(ctx.log).toHaveBeenCalledWith(
      "WARN",
      expect.stringContaining("policy"),
      expect.anything()
    );
  });

  it("returns the delivery counts once the run succeeded", async () => {
    mockGetRun.mockResolvedValue(
      run("succeeded", {
        delivery_result: "delivered",
        delivery_submitted: 42,
        delivery_conflicts: 0,
      })
    );
    const ctx = buildMockContext({
      handlerConfig: config,
      waitState: { runId: "r1", start: "2025-01-01", end: "2025-03-31", lastStatus: "running" },
    });

    const output = await ocsPipelineRun.execute(ctx);

    expect(mockGetRun).toHaveBeenCalledWith("chirps-precip-district", "r1");
    expect(output).toMatchObject({
      runId: "r1",
      submitted: 42,
      conflicts: 0,
      deliveryResult: "delivered",
    });
  });

  it("fails without retries when the delivery needs attention", async () => {
    mockGetRun.mockResolvedValue(
      run("needs_attention", { failure: { stage: "delivery", message: "3 conflicts" } })
    );
    const ctx = buildMockContext({ handlerConfig: config, waitState: { runId: "r1" } });

    const error = await caught(ocsPipelineRun.execute(ctx));

    expect(error).toBeInstanceOf(StepPermanentError);
    expect((error as Error).message).toContain("3 conflicts");
  });

  it("keeps waiting when the run status cannot be read", async () => {
    mockGetRun.mockRejectedValue(new Error("ECONNREFUSED"));
    const ctx = buildMockContext({
      handlerConfig: config,
      waitState: { runId: "r1", statusErrors: 2 },
    });

    const error = await caught(ocsPipelineRun.execute(ctx));

    expect(error).toBeInstanceOf(StepWaitingError);
    expect((error as StepWaitingError).state).toMatchObject({ statusErrors: 3 });
  });
});
