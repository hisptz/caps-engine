import type { Channel } from "amqplib";
import amqplib, { type ChannelModel } from "amqplib";
import { setupTopology } from "@/services/worker/services/monitor/topology.ts";

let _channel: Channel | null = null;
let _connection: ChannelModel | null = null;
let _init: Promise<void> | null = null;

export function apiChannel(): Channel {
  if (!_channel) {
    throw new Error("AMQP channel not initialized. Call initializeApiAmqp() first.");
  }
  return _channel;
}

export async function initializeApiAmqp(): Promise<void> {
  _init ??= (async () => {
    _connection = await amqplib.connect(process.env.RABBITMQ_URL ?? "amqp://localhost");
    _channel = await _connection.createChannel();
    await setupTopology(_channel);
  })();
  await _init;
}

export async function closeApiAmqp(): Promise<void> {
  if (_channel) await _channel.close();
  if (_connection) await _connection.close();
}
