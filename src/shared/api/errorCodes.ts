export const ApiErrorCode = {
  VALIDATION_ERROR: "validation_error",
  NOT_FOUND: "not_found",
  INTERNAL_ERROR: "internal_error",

  PIPELINE_NOT_FOUND: "pipeline_not_found",
  PIPELINE_DUPLICATE_NAME: "pipeline_duplicate_name",
  PIPELINE_HAS_ACTIVE_EXECUTIONS: "pipeline_has_active_executions",
  PIPELINE_TRIGGER_SKIPPED: "pipeline_trigger_skipped",

  STEP_NOT_FOUND: "step_not_found",
  STEP_ORDER_TAKEN: "step_order_taken",
  STEP_HANDLER_CONFIG_INVALID: "step_handler_config_invalid",

  SCHEDULE_NOT_FOUND: "schedule_not_found",

  EXECUTION_NOT_FOUND: "execution_not_found",
  EXECUTION_INVALID_STATE: "execution_invalid_state",
  STEP_EXECUTION_NOT_FOUND: "step_execution_not_found",
  TASK_EXECUTION_NOT_FOUND: "task_execution_not_found",
  DEAD_LETTER_NOT_FOUND: "dead_letter_not_found",

  CLIMATE_API_UNAVAILABLE: "climate_api_unavailable",
  CLIMATE_RESOURCE_NOT_FOUND: "climate_resource_not_found",
  CLIMATE_VALIDATION_ERROR: "climate_validation_error",
  DATASET_NOT_FOUND: "dataset_not_found",

  CHAP_UNAVAILABLE: "chap_unavailable",

  SYSTEM_INFO_UNAVAILABLE: "system_info_unavailable",
} as const;

export type ApiErrorCodeValue = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
