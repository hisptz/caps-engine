/**
 * Where a finished step's result lives in the execution context. Each result is stored twice:
 *
 * - `step_<n>_output` by position: the next step reads its input from here, and older connector
 *   rules refer to it.
 * - `stepOutputs.<stepId>` by step id: connector rules use this so they keep pointing at the same
 *   step when the pipeline's steps are reordered. (`steps.<stepId>` is taken: it holds
 *   per-run setting overrides.)
 */
export const STEP_OUTPUTS_KEY = "stepOutputs";

export function withStepOutput(
  context: Record<string, unknown>,
  stepIndex: number,
  stepId: string,
  output: unknown
): Record<string, unknown> {
  const existing = context[STEP_OUTPUTS_KEY];
  const byStepId =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...context,
    [`step_${stepIndex}_output`]: output ?? null,
    [STEP_OUTPUTS_KEY]: { ...byStepId, [stepId]: output ?? null },
  };
}
