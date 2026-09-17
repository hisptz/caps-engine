import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { metrics } from "@opentelemetry/api";
import { version } from "../../../package.json";
import { env } from "@/shared/utils";

/** Call once at process startup before processing any messages. */
export function setupTelemetry(): () => Promise<void> {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "caps",
    [ATTR_SERVICE_VERSION]: version,
  });

  // ---- Traces ----
  const traceProcessors = endpoint
    ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))]
    : [];

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: traceProcessors,
  });
  tracerProvider.register();

  // ---- Metrics ----
  const metricReaders = endpoint
    ? [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
          exportIntervalMillis: 30_000,
        }),
      ]
    : [];

  const meterProvider = new MeterProvider({ resource, readers: metricReaders });
  metrics.setGlobalMeterProvider(meterProvider);

  return async () => {
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  };
}
