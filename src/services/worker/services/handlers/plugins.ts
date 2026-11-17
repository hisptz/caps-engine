import type { HandlerPlugin } from "@/shared/handlers/plugin.ts";
import openClimateServiceSync from "./openClimateServiceSync/plugin.ts";
import climateOpenEoCreate from "./climateOpenEoCreate/plugin.ts";
import climateOpenEoPoll from "./climateOpenEoPoll/plugin.ts";
import climateOpenEoDownload from "./climateOpenEoDownload/plugin.ts";
import predictionTrigger from "./predictionTrigger/plugin.ts";
import predictionPoll from "./predictionPoll/plugin.ts";
import predictionDataDownload from "./predictionDataDownload/plugin.ts";
import dhis2InstancePull from "./dhis2InstancePull/plugin.ts";
import dhis2InstancePush from "./dhis2InstancePush/plugin.ts";
import dhis2DataCheck from "./dhis2DataCheck/plugin.ts";
import dhis2DataUpload from "./dhis2DataUpload/plugin.ts";
import dhis2AnalyticsRun from "./dhis2AnalyticsRun/plugin.ts";
import thresholdGeneration from "./thresholdGeneration/plugin.ts";
import alertGeneration from "./alertGeneration/plugin.ts";
import eventDataUpload from "./eventDataUpload/plugin.ts";
import dhis2Notify from "./dhis2Notify/plugin.ts";

export const BUILT_IN_PLUGINS: HandlerPlugin[] = [
  openClimateServiceSync,
  climateOpenEoCreate,
  climateOpenEoPoll,
  climateOpenEoDownload,
  predictionTrigger,
  predictionPoll,
  predictionDataDownload,
  dhis2InstancePull,
  dhis2InstancePush,
  dhis2DataCheck,
  dhis2DataUpload,
  dhis2AnalyticsRun,
  dhis2Notify,
  thresholdGeneration,
  alertGeneration,
  eventDataUpload,
];
