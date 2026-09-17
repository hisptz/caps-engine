import { describe, it, expect, vi, beforeEach } from "vitest";
import { PipelineExecutionStatus } from "@db/client.ts";
import { DlxMonitor, replayDeadMessage } from "@/services/worker/services/monitor/monitor.ts";
import { logger } from "@/shared/utils";
import type { ConsumeMessage } from "amqplib";
import type { PrismaClient } from "@db/client.ts";

// ============================================================
// DlxMonitor unit tests — fully mocked Prisma + channel
// No real database or RabbitMQ needed.
// ============================================================

// ============================================================
// Mock factories
// ============================================================

type MockPrisma = {
  pipelineExecution: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  executionLog: {
    create: ReturnType<typeof vi.fn>;
  };
};

function buildMockPrisma(): MockPrisma {
  return {
    pipelineExecution: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    executionLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

function buildMockChannel() {
  return {
    sendToQueue: vi.fn().mockReturnValue(true),
    consume: vi
      .fn()
      .mockImplementation((_queue: string, handler: (msg: ConsumeMessage) => Promise<void>) => {
        // Capture the handler so tests can invoke it
        capturedConsumeHandler = handler;
        return { consumerTag: "test-tag" };
      }),
    ack: vi.fn(),
    nack: vi.fn(),
  };
}

// Shared state to capture the consume callback registered by DlxMonitor.start()
let capturedConsumeHandler: ((msg: ConsumeMessage) => Promise<void>) | null = null;

function buildDeadMessage(
  body: Record<string, unknown>,
  headers: Record<string, unknown> = {}
): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(body)),
    properties: {
      headers: {
        "x-death": [
          {
            queue: "pipeline.executions",
            reason: "rejected",
            time: { value: Math.floor(Date.now() / 1000) },
            count: 1,
            "routing-keys": ["pipeline.executions"],
            exchange: "",
          },
        ],
        "x-first-death-queue": "pipeline.executions",
        "x-first-death-reason": "rejected",
        ...headers,
      },
      contentType: "application/json",
      contentEncoding: undefined,
      deliveryMode: 2,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: "caps.dlx",
      routingKey: "pipeline.executions",
      consumerTag: "test-tag",
      messageCount: undefined,
    },
  } as unknown as ConsumeMessage;
}

// ============================================================
// Test setup
// ============================================================

let mockPrisma: MockPrisma;
let mockChannel: ReturnType<typeof buildMockChannel>;

beforeEach(async () => {
  capturedConsumeHandler = null;
  mockPrisma = buildMockPrisma();
  mockChannel = buildMockChannel();
  // Start the monitor so the consume handler is captured
  const monitor = new DlxMonitor(mockPrisma as unknown as PrismaClient, mockChannel as never);
  await monitor.start();
});

// ============================================================
// Tests
// ============================================================

describe("DlxMonitor — dead message handling", () => {
  it("marks execution FAILED when dead message arrives and execution is in RUNNING state", async () => {
    const executionId = "exec-running-123";
    mockPrisma.pipelineExecution.findUnique.mockResolvedValue({
      id: executionId,
      status: PipelineExecutionStatus.RUNNING,
    });

    await capturedConsumeHandler!(buildDeadMessage({ executionId }));

    expect(mockPrisma.pipelineExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: executionId },
        data: expect.objectContaining({
          status: PipelineExecutionStatus.FAILED,
          finishedAt: expect.any(Date),
        }),
      })
    );
    expect(mockChannel.ack).toHaveBeenCalled();
  });

  it("marks execution FAILED when execution is in AWAITING_STEP state", async () => {
    const executionId = "exec-awaiting-456";
    mockPrisma.pipelineExecution.findUnique.mockResolvedValue({
      id: executionId,
      status: PipelineExecutionStatus.AWAITING_STEP,
    });

    await capturedConsumeHandler!(buildDeadMessage({ executionId }));

    expect(mockPrisma.pipelineExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: executionId },
        data: expect.objectContaining({ status: PipelineExecutionStatus.FAILED }),
      })
    );
  });

  it("marks execution FAILED when execution is in PENDING state", async () => {
    const executionId = "exec-pending-789";
    mockPrisma.pipelineExecution.findUnique.mockResolvedValue({
      id: executionId,
      status: PipelineExecutionStatus.PENDING,
    });

    await capturedConsumeHandler!(buildDeadMessage({ executionId }));

    expect(mockPrisma.pipelineExecution.update).toHaveBeenCalled();
  });

  it("does NOT update execution when it is already COMPLETED", async () => {
    const executionId = "exec-done-999";
    mockPrisma.pipelineExecution.findUnique.mockResolvedValue({
      id: executionId,
      status: PipelineExecutionStatus.COMPLETED,
    });

    await capturedConsumeHandler!(buildDeadMessage({ executionId }));

    expect(mockPrisma.pipelineExecution.update).not.toHaveBeenCalled();
  });

  it("does NOT update execution when it is already FAILED", async () => {
    const executionId = "exec-already-failed";
    mockPrisma.pipelineExecution.findUnique.mockResolvedValue({
      id: executionId,
      status: PipelineExecutionStatus.FAILED,
    });

    await capturedConsumeHandler!(buildDeadMessage({ executionId }));

    expect(mockPrisma.pipelineExecution.update).not.toHaveBeenCalled();
  });

  it("creates an ExecutionLog entry for dead-lettered active executions", async () => {
    const executionId = "exec-log-111";
    mockPrisma.pipelineExecution.findUnique.mockResolvedValue({
      id: executionId,
      status: PipelineExecutionStatus.RUNNING,
    });

    await capturedConsumeHandler!(buildDeadMessage({ executionId }));

    expect(mockPrisma.executionLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          executionId,
          level: "ERROR",
          message: expect.stringContaining("dead-lettered"),
        }),
      })
    );
  });

  it("logs a warning and does not throw when no executionId in body", async () => {
    const loggerSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    mockPrisma.pipelineExecution.findUnique.mockResolvedValue(null);

    const msg = buildDeadMessage({ someOtherField: "data", executionId: undefined });
    // Remove executionId entirely
    const bodyWithoutId = { someOtherField: "data" };
    const msgWithoutId: ConsumeMessage = {
      ...msg,
      content: Buffer.from(JSON.stringify(bodyWithoutId)),
    };

    await expect(capturedConsumeHandler!(msgWithoutId)).resolves.toBeUndefined();
    expect(mockPrisma.pipelineExecution.update).not.toHaveBeenCalled();
    expect(loggerSpy).toHaveBeenCalled();
  });

  it("handles unparseable message body gracefully without throwing", async () => {
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    const badMsg: ConsumeMessage = {
      content: Buffer.from("not-valid-json{{{{"),
      properties: {
        headers: {},
        contentType: "application/json",
        contentEncoding: undefined,
        deliveryMode: 2,
        priority: undefined,
        correlationId: undefined,
        replyTo: undefined,
        expiration: undefined,
        messageId: undefined,
        timestamp: undefined,
        type: undefined,
        userId: undefined,
        appId: undefined,
        clusterId: undefined,
      },
      fields: {
        deliveryTag: 2,
        redelivered: false,
        exchange: "caps.dlx",
        routingKey: "",
        consumerTag: "test-tag",
        messageCount: undefined,
      },
    } as unknown as ConsumeMessage;

    await expect(capturedConsumeHandler!(badMsg)).resolves.toBeUndefined();
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not parse"),
      expect.anything()
    );
    expect(mockPrisma.pipelineExecution.update).not.toHaveBeenCalled();
  });

  it("acks the message even when the execution is not found", async () => {
    mockPrisma.pipelineExecution.findUnique.mockResolvedValue(null);

    await capturedConsumeHandler!(buildDeadMessage({ executionId: "ghost-id" }));

    expect(mockChannel.ack).toHaveBeenCalled();
  });

  it("acks the message even after a DB error to prevent infinite dead-letter loop", async () => {
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    mockPrisma.pipelineExecution.findUnique.mockRejectedValue(new Error("DB connection lost"));

    await expect(
      capturedConsumeHandler!(buildDeadMessage({ executionId: "exec-db-error" }))
    ).resolves.toBeUndefined();

    expect(loggerSpy).toHaveBeenCalled();
    expect(mockChannel.ack).toHaveBeenCalled();
  });
});

describe("replayDeadMessage", () => {
  it("publishes to the correct target queue with the message body", () => {
    const channel = buildMockChannel();
    const body = { executionId: "exec-replay-001", someField: "value" };

    replayDeadMessage(channel as never, "pipeline.executions", body);

    expect(channel.sendToQueue).toHaveBeenCalledOnce();
    const [queue, bufArg, options] = channel.sendToQueue.mock.calls[0]!;
    expect(queue).toBe("pipeline.executions");
    expect(JSON.parse((bufArg as Buffer).toString())).toEqual(body);
    expect((options as Record<string, unknown>)["persistent"]).toBe(true);
  });

  it("sends with empty headers to strip x-death metadata", () => {
    const channel = buildMockChannel();

    replayDeadMessage(channel as never, "pipeline.executions", { executionId: "exec-strip" });

    const [, , options] = channel.sendToQueue.mock.calls[0]!;
    expect((options as Record<string, unknown>)["headers"]).toEqual({});
  });

  it("can replay to a step-specific queue", () => {
    const channel = buildMockChannel();
    const body = { executionId: "exec-step", stepExecutionId: "step-exec-123" };

    replayDeadMessage(channel as never, "step.climate-data-download", body);

    const [queue] = channel.sendToQueue.mock.calls[0]!;
    expect(queue).toBe("step.climate-data-download");
  });
});
