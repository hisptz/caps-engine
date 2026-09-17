export enum ServiceType {
  API = "api",
  DHIS2_DATA_IMPORT = "dhis2-data-import",
  CLIMATE_DATA_DOWNLOAD = "climate-data-download",
  PREDICTION_TRIGGER = "prediction-trigger",
  THRESHOLD_GENERATION = "threshold-generation",
  SCHEDULER = "scheduler",
  TRIGGER = "trigger",
}

export const services: Map<ServiceType, Record<string, string | number>> = new Map([
  [
    ServiceType.API,
    {
      name: "API",
    },
  ],
  [
    ServiceType.DHIS2_DATA_IMPORT,
    {
      name: "DHIS2 Data Import",
    },
  ],
  [ServiceType.CLIMATE_DATA_DOWNLOAD, { name: "Climate Data Download" }],
  [
    ServiceType.PREDICTION_TRIGGER,
    {
      name: "Prediction Trigger",
    },
  ],
  [
    ServiceType.THRESHOLD_GENERATION,
    {
      name: "Threshold Generation",
    },
  ],
  [ServiceType.SCHEDULER, { name: "Scheduler" }],
  [ServiceType.TRIGGER, { name: "Trigger" }],
]);
