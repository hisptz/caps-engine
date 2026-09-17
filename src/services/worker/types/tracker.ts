export type TrackerDataValue = {
  dataElement: string;
  value: string;
};

export type TrackerEvent = {
  program: string;
  programStage?: string;
  orgUnit: string;
  occurredAt: string;
  status: string;
  dataValues: TrackerDataValue[];
};

export type TrackerImportBody = {
  events: TrackerEvent[];
};

export type TrackerImportStats = {
  created: number;
  updated: number;
  ignored: number;
  deleted: number;
  total: number;
};

export type TrackerImportReport = {
  status: string;
  stats?: TrackerImportStats;
};
