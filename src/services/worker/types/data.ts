export interface DataPayload {
  dataValues: DataValueSet[];
}
export interface DataValue {
  dataElement: string;
  period: string;
  orgUnit: string;
  categoryOptionCombo?: string;
  attributeOptionCombo?: string;
  value: string;
  storedBy?: string;
  comment?: string;
}
export interface DataValueSet {
  dataSet?: string;
  completeDate?: string;
  period?: string;
  orgUnit?: string;
  attributeOptionCombo?: string;
  dataValues: DataValue[];
}
export interface ImportSummary {
  status: string;
  description?: string;
  importOptions?: Record<string, unknown>;
  importCount?: {
    imported: number;
    updated: number;
    ignored: number;
    deleted: number;
  };
  conflicts?: Array<{ object: string; value: string }>;
  dataSetComplete?: string;
}
