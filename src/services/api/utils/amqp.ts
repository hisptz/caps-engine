import type { Channel } from "amqplib";
import amqp, { type ChannelWrapper, type AmqpConnectionManager } from "amqp-connection-manager";
import { setupTopology } from "@/services/worker/services/monitor/topology.ts";
import { logger } from "@/shared/utils";

let _channel: ChannelWrapper | null = null;
let _connection: AmqpConnectionManager | null = null;
let _init: Promise<void> | null = null;

export function apiChannel(): ChannelWrapper {
  if (!_channel) {
    throw new Error("AMQP channel not initialized. Call initializeApiAmqp() first.");
  }
  return _channel;
}

export async function initializeApiAmqp(): Promise<void> {
  _init ??= (async () => {
    // Reconnects automatically and re-declares the topology on every new connection
    const connection = amqp.connect([process.env.RABBITMQ_URL ?? "amqp://localhost"], {
      heartbeatIntervalInSeconds: 60,
      reconnectTimeInSeconds: 5,
    });
    connection.on("disconnect", ({ err }: { err?: Error }) => {
      logger.warn("[api] RabbitMQ disconnected — reconnecting:", err);
    });
    const channel = connection.createChannel({
      name: "api",
      confirm: true,
      publishTimeout: 10_000,
      setup: (raw: Channel) => setupTopology(raw),
    });
    channel.on("error", (err) => {
      logger.error("[api] RabbitMQ channel error:", err);
    });
    _connection = connection;
    _channel = channel;
    await channel.waitForConnect();
  })();
  await _init;
}

export async function closeApiAmqp(): Promise<void> {
  if (_channel) await _channel.close();
  if (_connection) await _connection.close();
}
