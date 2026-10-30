import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorRunStatus, ConnectorTriggerOn } from "@db/client";
import { ApiError } from "@/shared/api/errors.ts";
import { ApiErrorCode } from "@/shared/api/errorCodes.ts";
import { createConnectorBody } from "@/services/api/modules/connectors/model.ts";

const db = vi.hoisted(() => ({
  pipeline: { count: vi.fn(), findMany: vi.fn() },
  pipelineConnector: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  connectorRun: { findUnique: vi.fn(), updateMany: vi.fn() },
}));

vi.mock("@/services/api/utils/db.ts", () => ({ apiDb: db }));

const { ConnectorService } = await import("@/services/api/modules/connectors/service.ts");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4111-8111-222222222222";
const C = "33333333-3333-4111-8111-333333333333";

function connectorBody(overrides: Record<string, unknown> = {}) {
  return createConnectorBody.parse({
    name: "A to B",
    sourcePipelineId: A,
    targetPipelineId: B,
    ...overrides,
  });
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

describe("createConnectorBody", () => {
  it("defaults to firing on completion with no delay", () => {
    expect(connectorBody()).toMatchObject({
      on: ConnectorTriggerOn.COMPLETED,
      delayMinutes: 0,
      inputMapping: {},
      isActive: true,
    });
  });

  it("rejects an unsupported rule operator", () => {
    const result = createConnectorBody.safeParse({
      name: "x",
      sourcePipelineId: A,
      targetPipelineId: B,
      condition: { eval: ["process.exit()"] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a null rule", () => {
    expect(connectorBody({ condition: null }).condition).toBeNull();
  });
});

describe("ConnectorService", () => {
  let service: InstanceType<typeof ConnectorService>;

  beforeEach(() => {
    service = new ConnectorService();
    db.pipeline.count.mockResolvedValue(2);
    db.pipelineConnector.findMany.mockResolvedValue([]);
    db.pipelineConnector.create.mockImplementation(({ data }: { data: object }) => data);
  });

  it("creates a connector between existing pipelines", async () => {
    await service.createConnector(connectorBody());

    expect(db.pipelineConnector.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourcePipelineId: A, targetPipelineId: B }),
      })
    );
  });

  it("returns 404 when a pipeline does not exist", async () => {
    db.pipeline.count.mockResolvedValue(1);

    await expectApiError(
      service.createConnector(connectorBody()),
      404,
      ApiErrorCode.PIPELINE_NOT_FOUND
    );
    expect(db.pipelineConnector.create).not.toHaveBeenCalled();
  });

  it("returns 409 naming the loop when the connector would close one", async () => {
    db.pipelineConnector.findMany.mockResolvedValue([
      { sourcePipelineId: B, targetPipelineId: C },
      { sourcePipelineId: C, targetPipelineId: A },
    ]);
    db.pipeline.findMany.mockResolvedValue([
      { id: A, name: "Prediction" },
      { id: B, name: "Review" },
      { id: C, name: "Release" },
    ]);

    const err = await expectApiError(
      service.createConnector(connectorBody()),
      409,
      ApiErrorCode.CONNECTOR_CREATES_CYCLE
    );
    expect(err.message).toBe(
      "Connector would create a loop: Prediction → Review → Release → Prediction"
    );
    expect(db.pipelineConnector.create).not.toHaveBeenCalled();
  });

  it("creates a connector with an otherwise pipeline behind a rule", async () => {
    db.pipeline.count.mockResolvedValue(3);

    await service.createConnector(
      connectorBody({ otherwisePipelineId: C, condition: { ">": [{ var: "context.n" }, 0] } })
    );

    expect(db.pipeline.count).toHaveBeenCalledWith({ where: { id: { in: [A, B, C] } } });
    expect(db.pipelineConnector.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ otherwisePipelineId: C }) })
    );
  });

  it("rejects an otherwise pipeline without a rule", async () => {
    await expectApiError(
      service.createConnector(connectorBody({ otherwisePipelineId: C })),
      400,
      ApiErrorCode.CONNECTOR_OTHERWISE_INVALID
    );
    expect(db.pipelineConnector.create).not.toHaveBeenCalled();
  });

  it("rejects an otherwise pipeline that is the target itself", async () => {
    await expectApiError(
      service.createConnector(
        connectorBody({ otherwisePipelineId: B, condition: { ">": [{ var: "context.n" }, 0] } })
      ),
      400,
      ApiErrorCode.CONNECTOR_OTHERWISE_INVALID
    );
  });

  it("returns 409 when the otherwise pipeline would close a loop", async () => {
    db.pipeline.count.mockResolvedValue(3);
    db.pipelineConnector.findMany.mockResolvedValue([
      { sourcePipelineId: C, targetPipelineId: A, otherwisePipelineId: null },
    ]);
    db.pipeline.findMany.mockResolvedValue([]);

    await expectApiError(
      service.createConnector(
        connectorBody({ otherwisePipelineId: C, condition: { ">": [{ var: "context.n" }, 0] } })
      ),
      409,
      ApiErrorCode.CONNECTOR_CREATES_CYCLE
    );
  });

  it("counts existing otherwise pipelines when looking for loops", async () => {
    db.pipelineConnector.findMany.mockResolvedValue([
      { sourcePipelineId: B, targetPipelineId: C, otherwisePipelineId: A },
    ]);
    db.pipeline.findMany.mockResolvedValue([]);

    await expectApiError(
      service.createConnector(connectorBody()),
      409,
      ApiErrorCode.CONNECTOR_CREATES_CYCLE
    );
  });

  it("removing the rule of a connector with an otherwise pipeline is rejected", async () => {
    db.pipelineConnector.findUnique.mockResolvedValue({
      id: "connector-1",
      sourcePipelineId: A,
      targetPipelineId: B,
      otherwisePipelineId: C,
      condition: { ">": [{ var: "context.n" }, 0] },
      isActive: true,
    });

    await expectApiError(
      service.updateConnector("connector-1", { condition: null }),
      400,
      ApiErrorCode.CONNECTOR_OTHERWISE_INVALID
    );
    expect(db.pipelineConnector.update).not.toHaveBeenCalled();
  });

  it("skips the loop check for an inactive connector", async () => {
    db.pipelineConnector.findMany.mockResolvedValue([{ sourcePipelineId: B, targetPipelineId: A }]);

    await service.createConnector(connectorBody({ isActive: false }));

    expect(db.pipelineConnector.create).toHaveBeenCalled();
  });

  it("checks for loops again when an inactive connector is switched on", async () => {
    db.pipelineConnector.findUnique.mockResolvedValue({
      id: "connector-1",
      sourcePipelineId: A,
      targetPipelineId: B,
      isActive: false,
    });
    db.pipelineConnector.findMany.mockResolvedValue([{ sourcePipelineId: B, targetPipelineId: A }]);
    db.pipeline.findMany.mockResolvedValue([]);

    await expectApiError(
      service.updateConnector("connector-1", { isActive: true }),
      409,
      ApiErrorCode.CONNECTOR_CREATES_CYCLE
    );
    expect(db.pipelineConnector.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, id: { not: "connector-1" } } })
    );
  });

  it("does not check for loops when only the rule changes", async () => {
    db.pipelineConnector.findUnique.mockResolvedValue({
      id: "connector-1",
      sourcePipelineId: A,
      targetPipelineId: B,
      isActive: true,
    });

    await service.updateConnector("connector-1", { condition: { "!!": [true] } });

    expect(db.pipelineConnector.findMany).not.toHaveBeenCalled();
    expect(db.pipelineConnector.update).toHaveBeenCalled();
  });

  it("cancels a waiting connector run", async () => {
    db.connectorRun.findUnique.mockResolvedValue({ status: ConnectorRunStatus.WAITING });
    db.connectorRun.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.cancelConnectorRun("run-1")).resolves.toEqual({
      connectorRunId: "run-1",
      status: ConnectorRunStatus.CANCELLED,
    });
  });

  it("refuses to cancel a connector run that was already decided", async () => {
    db.connectorRun.findUnique.mockResolvedValue({ status: ConnectorRunStatus.FIRED });
    db.connectorRun.updateMany.mockResolvedValue({ count: 0 });

    await expectApiError(
      service.cancelConnectorRun("run-1"),
      409,
      ApiErrorCode.CONNECTOR_RUN_INVALID_STATE
    );
  });
});
