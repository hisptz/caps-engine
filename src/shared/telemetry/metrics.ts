import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("caps");

/** Total pipeline executions, labelled by outcome (succeeded | failed). */
export const pipelineExecutionCounter = meter.createCounter("caps.pipeline.executions", {
  description: "Number of pipeline executions completed",
});

/** Total step executions, labelled by handler_key and outcome. */
export const stepExecutionCounter = meter.createCounter("caps.step.executions", {
  description: "Number of step executions",
});

/** Wall-clock duration of each step execution in milliseconds. */
export const stepDurationHistogram = meter.createHistogram("caps.step.duration_ms", {
  description: "Duration of step executions",
  unit: "ms",
});
