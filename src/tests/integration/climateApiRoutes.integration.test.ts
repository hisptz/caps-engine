import { describe, it, expect, vi, beforeEach } from "vitest";
import axios, { type AxiosError } from "axios";

vi.mock("@/shared/clients/climateApi.ts", () => ({
  climateApiClient: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import { climateApiClient } from "@/shared/clients/climateApi.ts";
import { ClimateService } from "@/services/api/modules/climate/service.ts";
import { ApiError } from "@/shared/api/errors.ts";

const climateService = new ClimateService();

const mockGet = vi.mocked(climateApiClient.get);
const mockPost = vi.mocked(climateApiClient.post);
const mockDelete = vi.mocked(climateApiClient.delete);

function makeAxiosError(status?: number): AxiosError {
  const err = new axios.AxiosError("Request failed");
  if (status !== undefined) {
    err.response = {
      status,
      data: {},
      headers: {},
      config: {} as never,
      statusText: String(status),
    };
  }
  return err;
}

async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error("expected promise to reject with an ApiError");
}

describe("ClimateService.listCollections", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  const catalog = {
    type: "Catalog",
    links: [
      { rel: "self", href: "http://ocs.example/stac" },
      { rel: "child", href: "http://ocs.example/stac/collections/chirps3_precipitation_daily" },
      { rel: "child", href: "http://ocs.example/stac/collections/era5_land_temperature/" },
    ],
  };

  it("follows each child link of the catalogue", async () => {
    mockGet
      .mockResolvedValueOnce({ data: catalog })
      .mockResolvedValueOnce({ data: { id: "chirps3_precipitation_daily" } })
      .mockResolvedValueOnce({ data: { id: "era5_land_temperature" } });

    const result = await climateService.listCollections();

    expect(result).toEqual({
      collections: [{ id: "chirps3_precipitation_daily" }, { id: "era5_land_temperature" }],
    });
    expect(mockGet).toHaveBeenNthCalledWith(1, "/stac");
    expect(mockGet).toHaveBeenCalledWith("/stac/collections/chirps3_precipitation_daily");
    expect(mockGet).toHaveBeenCalledWith("/stac/collections/era5_land_temperature");
  });

  it("skips a collection that fails to load", async () => {
    mockGet
      .mockResolvedValueOnce({ data: catalog })
      .mockRejectedValueOnce(makeAxiosError(503))
      .mockResolvedValueOnce({ data: { id: "era5_land_temperature" } });

    const result = await climateService.listCollections();

    expect(result).toEqual({ collections: [{ id: "era5_land_temperature" }] });
  });

  it("returns no collections for an empty catalogue", async () => {
    mockGet.mockResolvedValueOnce({ data: { type: "Catalog", links: [] } });

    expect(await climateService.listCollections()).toEqual({ collections: [] });
  });

  it("throws a 502 ApiError when the catalogue is unavailable", async () => {
    mockGet.mockRejectedValueOnce(makeAxiosError(502));

    const err = await expectApiError(climateService.listCollections());

    expect(err.status).toBe(502);
    expect(err.code).toBe("climate_api_unavailable");
  });
});

describe("ClimateService.getCollection", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns the STAC collection on success", async () => {
    const collection = { type: "Collection", id: "chirps3_precipitation_daily" };
    mockGet.mockResolvedValueOnce({ data: collection });

    const result = await climateService.getCollection("chirps3_precipitation_daily");

    expect(result).toEqual(collection);
    expect(mockGet).toHaveBeenCalledWith("/stac/collections/chirps3_precipitation_daily");
  });

  it("throws a 404 ApiError when the collection is not published", async () => {
    mockGet.mockRejectedValueOnce(makeAxiosError(404));

    const err = await expectApiError(climateService.getCollection("missing"));

    expect(err.status).toBe(404);
    expect(err.code).toBe("collection_not_found");
    expect(err.details).toEqual({ collectionId: "missing" });
  });

  it("throws a 502 ApiError on upstream error", async () => {
    mockGet.mockRejectedValueOnce(makeAxiosError(502));

    const err = await expectApiError(climateService.getCollection("x"));

    expect(err.status).toBe(502);
    expect(err.code).toBe("climate_api_unavailable");
  });
});

describe("ClimateService.listDataSources", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns data sources on success", async () => {
    const templates = [{ dataset_id: "chirps3_precipitation_daily" }];
    mockGet.mockResolvedValueOnce({ data: templates });

    const result = await climateService.listDataSources();

    expect(result).toEqual(templates);
    expect(mockGet).toHaveBeenCalledWith("/data-sources");
  });
});

describe("ClimateService.getDataSource", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns data source detail on success", async () => {
    const template = { dataset_id: "chirps3_precipitation_daily" };
    mockGet.mockResolvedValueOnce({ data: template });

    const result = await climateService.getDataSource("chirps3_precipitation_daily");

    expect(result).toEqual(template);
    expect(mockGet).toHaveBeenCalledWith("/data-sources/chirps3_precipitation_daily");
  });
});

describe("ClimateService.listIngestions", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns ingestion list on success", async () => {
    const payload = { kind: "IngestionList", items: [] };
    mockGet.mockResolvedValueOnce({ data: payload });

    const result = await climateService.listIngestions();

    expect(result).toEqual(payload);
    expect(mockGet).toHaveBeenCalledWith("/ingestions");
  });
});

describe("ClimateService.createIngestion", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("forwards Prefer header and normalizes async 202 response by default", async () => {
    mockPost.mockResolvedValueOnce({
      status: 202,
      data: { ingestion_id: "ing-1", status: "accepted" },
      headers: { location: "/ingestions/jobs/job-abc" },
      config: {} as never,
      statusText: "Accepted",
    });

    const body = {
      dataset_id: "chirps3_precipitation_daily",
      start: "2024-01-01",
      overwrite: false,
      publish: true,
    };
    const response = await climateService.createIngestion({ async: true }, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jobId: "job-abc",
      status: "accepted",
      ingestion_id: "ing-1",
    });
    expect(mockPost).toHaveBeenCalledWith("/ingestions", body, {
      headers: { Prefer: "respond-async" },
    });
  });

  it("omits Prefer header when async=false", async () => {
    const upstream = { ingestion_id: "ing-1", status: "completed" };
    mockPost.mockResolvedValueOnce({
      status: 200,
      data: upstream,
      headers: {},
      config: {} as never,
      statusText: "OK",
    });

    const body = {
      dataset_id: "chirps3_precipitation_daily",
      start: "2024-01-01",
      overwrite: false,
      publish: true,
    };
    const response = await climateService.createIngestion({ async: false }, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(upstream);
    expect(mockPost).toHaveBeenCalledWith("/ingestions", body, { headers: {} });
  });

  it("forwards an ingestion body without start for forecast templates", async () => {
    mockPost.mockResolvedValueOnce({
      status: 202,
      data: { ingestion_id: "ing-forecast", status: "accepted" },
      headers: { location: "/ingestions/jobs/job-forecast" },
      config: {} as never,
      statusText: "Accepted",
    });

    const body = {
      dataset_id: "forecast_template",
      overwrite: false,
      publish: true,
    };
    const response = await climateService.createIngestion({ async: true }, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jobId: "job-forecast",
      status: "accepted",
      ingestion_id: "ing-forecast",
    });
    expect(mockPost).toHaveBeenCalledWith("/ingestions", body, {
      headers: { Prefer: "respond-async" },
    });
  });
});

describe("ClimateService.getIngestion", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns ingestion record on success", async () => {
    const record = { ingestion_id: "ing-1", status: "completed" };
    mockGet.mockResolvedValueOnce({ data: record });

    const result = await climateService.getIngestion("ing-1");

    expect(result).toEqual(record);
    expect(mockGet).toHaveBeenCalledWith("/ingestions/ing-1");
  });
});

describe("ClimateService.getIngestionJob", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns job record on success", async () => {
    const job = { jobID: "job-abc", status: "running" };
    mockGet.mockResolvedValueOnce({ data: job });

    const result = await climateService.getIngestionJob("job-abc");

    expect(result).toEqual(job);
    expect(mockGet).toHaveBeenCalledWith("/ingestions/jobs/job-abc");
  });
});

describe("ClimateService.cancelIngestionJob", () => {
  beforeEach(() => {
    mockDelete.mockReset();
  });

  it("returns upstream status and body on success", async () => {
    const jobRecord = { jobID: "job-abc", status: "cancelled" };
    mockDelete.mockResolvedValueOnce({
      status: 202,
      data: jobRecord,
      headers: {},
      config: {} as never,
      statusText: "Accepted",
    });

    const response = await climateService.cancelIngestionJob("job-abc");

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(jobRecord);
    expect(mockDelete).toHaveBeenCalledWith("/ingestions/jobs/job-abc");
  });
});

describe("ClimateService.syncDataset", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("forwards Prefer header and normalizes async 202 response by default", async () => {
    mockPost.mockResolvedValueOnce({
      status: 202,
      data: { status: "accepted" },
      headers: { location: "/ingestions/jobs/sync-job-1" },
      config: {} as never,
      statusText: "Accepted",
    });

    const body = { publish: true };
    const response = await climateService.syncDataset(
      "chirps3_precipitation_daily_sle",
      { async: true },
      body
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jobId: "sync-job-1",
      status: "accepted",
    });
    expect(mockPost).toHaveBeenCalledWith("/sync/chirps3_precipitation_daily_sle", body, {
      headers: { Prefer: "respond-async" },
    });
  });
});

describe("ClimateService.planSync", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns sync plan on success", async () => {
    const plan = { source_dataset_id: "chirps3_precipitation_daily", action: "append" };
    mockGet.mockResolvedValueOnce({ data: plan });

    const result = await climateService.planSync("chirps3_precipitation_daily_sle", "2024-12-31");

    expect(result).toEqual(plan);
    expect(mockGet).toHaveBeenCalledWith("/sync/chirps3_precipitation_daily_sle/plan", {
      params: { end: "2024-12-31" },
    });
  });
});
