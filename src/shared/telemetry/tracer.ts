import { trace } from "@opentelemetry/api";

/**
 * Application-wide tracer.
 * Delegates to the global TracerProvider at span-creation time,
 * so this is safe to import before setupTelemetry() is called.
 */
export const tracer = trace.getTracer("caps");
