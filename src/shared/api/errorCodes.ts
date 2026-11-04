export const ApiErrorCode = {
  VALIDATION_ERROR: "validation_error",
  NOT_FOUND: "not_found",
  INTERNAL_ERROR: "internal_error",

  PIPELINE_NOT_FOUND: "pipeline_not_found",
  PIPELINE_DUPLICATE_NAME: "pipeline_duplicate_name",
  PIPELINE_HAS_ACTIVE_EXECUTIONS: "pipeline_has_active_executions",
  PIPELINE_TRIGGER_SKIPPED: "pipeline_trigger_skipped",
  PIPELINE_HAS_INCOMING_CONNECTORS: "pipeline_has_incoming_connectors",

  CONNECTOR_NOT_FOUND: "connector_not_found",
  CONNECTOR_CREATES_CYCLE: "connector_creates_cycle",
  CONNECTOR_RULE_INVALID: "connector_rule_invalid",
  CONNECTOR_OTHERWISE_INVALID: "connector_otherwise_invalid",
  CONNECTOR_RUN_NOT_FOUND: "connector_run_not_found",
  CONNECTOR_RUN_INVALID_STATE: "connector_run_invalid_state",

  PIPELINE_IN_OTHER_WORKFLOW: "pipeline_in_other_workflow",
  PIPELINE_NOT_IN_WORKFLOW: "pipeline_not_in_workflow",
  PIPELINE_IN_MERGE: "pipeline_in_merge",

  MERGE_NOT_FOUND: "merge_not_found",
  MERGE_INVALID: "merge_invalid",
  MERGE_CREATES_CYCLE: "merge_creates_cycle",
  MERGE_RUN_NOT_FOUND: "merge_run_not_found",
  MERGE_RUN_INVALID_STATE: "merge_run_invalid_state",

  WORKFLOW_NOT_FOUND: "workflow_not_found",
  WORKFLOW_DUPLICATE_NAME: "workflow_duplicate_name",
  WORKFLOW_INACTIVE: "workflow_inactive",
  WORKFLOW_EMPTY: "workflow_empty",
  WORKFLOW_RUN_NOT_FOUND: "workflow_run_not_found",
  WORKFLOW_RUN_PERIOD_INVALID: "workflow_run_period_invalid",
  WORKFLOW_NOT_FROM_TEMPLATE: "workflow_not_from_template",
  TEMPLATE_NOT_FOUND: "template_not_found",
  TEMPLATE_INVALID: "template_invalid",
  TEMPLATE_EDITED: "template_edited",

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
  COLLECTION_NOT_FOUND: "collection_not_found",

  CHAP_UNAVAILABLE: "chap_unavailable",

  SOURCE_ROUTE_UNAVAILABLE: "source_route_unavailable",

  INSTANCE_MAPPING_INVALID: "instance_mapping_invalid",
  INSTANCE_MAPPING_CONFLICT: "instance_mapping_conflict",
  INSTANCE_MAPPING_IN_USE: "instance_mapping_in_use",

  SYSTEM_INFO_UNAVAILABLE: "system_info_unavailable",
} as const;

export type ApiErrorCodeValue = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
