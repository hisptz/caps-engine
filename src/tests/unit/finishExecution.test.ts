import { describe, expect, it, vi } from "vitest";
import { ConnectorTriggerOn, PipelineExecutionStatus } from "@db/client";
import { finishExecution } from "@/shared/pipeline/finishExecution.ts";
import { QUEUES } from "@/services/worker/constants/monitor.ts";

function createTx(connectors: { id: string; delayMinutes: number }[]) {
  return {
    pipelineExecution: { update: vi.fn().mockResolvedValue({}) },
    pipelineConnector: { findMany: vi.fn().mockResolvedValue(connectors) },
    connectorRun: {
      createManyAndReturn: vi
        .fn()
        .mockImplementation(({ data }: { data: { connectorId: string; checkAt: Date }[] }) =>
          data.map((row) => ({ id: `run-${row.connectorId}`, checkAt: row.checkAt }))
        ),
    },
    outboxMessage: { create: vi.fn().mockResolvedValue({ id: "outbox-1" }) },
  };
}

describe("finishExecution", () => {
  it("marks the execution finished and creates no runs without connectors", async () => {
    const tx = createTx([]);

    const runs = await finishExecution(tx as never, {
      executionId: "exec-1",
      pipelineId: "pipe-1",
      status: PipelineExecutionStatus.COMPLETED,
    });

    expect(runs).toEqual([]);
    expect(tx.pipelineExecution.update).toHaveBeenCalledWith({
      where: { id: "exec-1" },
      data: { status: PipelineExecutionStatus.COMPLETED, finishedAt: expect.any(Date) },
    });
    expect(tx.connectorRun.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.outboxMessage.create).not.toHaveBeenCalled();
  });

  it("looks up active connectors for the matching outcome or any outcome", async () => {
    const tx = createTx([]);

    await finishExecution(tx as never, {
      executionId: "exec-1",
      pipelineId: "pipe-1",
      status: PipelineExecutionStatus.FAILED,
    });

    expect(tx.pipelineConnector.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sourcePipelineId: "pipe-1",
          isActive: true,
          on: { in: [ConnectorTriggerOn.FAILED, ConnectorTriggerOn.FINISHED] },
        },
      })
    );
  });

  it("creates a run per connector and queues each for when its delay is up", async () => {
    const tx = createTx([
      { id: "now", delayMinutes: 0 },
      { id: "later", delayMinutes: 30 },
    ]);
    const before = Date.now();

    const runs = await finishExecution(tx as never, {
      executionId: "exec-1",
      pipelineId: "pipe-1",
      status: PipelineExecutionStatus.COMPLETED,
    });

    expect(runs).toEqual(["run-now", "run-later"]);
    expect(tx.connectorRun.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );

    const outboxCalls = tx.outboxMessage.create.mock.calls.map(
      ([arg]) =>
        (arg as { data: { destination: string; availableAt: Date; payload: unknown } }).data
    );
    expect(outboxCalls).toHaveLength(2);
    expect(outboxCalls.every((row) => row.destination === QUEUES.PIPELINE_CONNECTORS)).toBe(true);
    expect(outboxCalls[0]!.payload).toEqual({ connectorRunId: "run-now" });
    expect(outboxCalls[1]!.availableAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
  });
});
