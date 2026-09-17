import { describe, it, expect, vi, beforeEach } from "vitest";
import { AxiosError } from "axios";

vi.mock("@/shared/clients/chap.ts", () => ({
  chapClient: {
    get: vi.fn(),
  },
}));

// Import after mock is set up
import { chapClient } from "@/shared/clients/chap.ts";
import { getModels } from "@/services/api/modules/models/service.ts";

const mockedChapGet = vi.mocked(chapClient.get);

describe("getModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns mapped models on success", async () => {
    mockedChapGet.mockResolvedValueOnce({
      data: [
        {
          id: 42,
          name: "seasonal_model",
          displayName: "Seasonal Model",
          supportedPeriodType: "month",
          covariates: [
            { name: "rainfall", displayName: "Rainfall", description: "Rainfall" },
            { name: "mean_temperature", displayName: "Mean temperature" },
          ],
          target: { name: "disease_cases", displayName: "Disease cases", description: "Cases" },
          extra: "ignored",
        },
      ],
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as never,
    });

    const body = await getModels();

    expect(body).toEqual({
      models: [
        {
          id: "42",
          name: "seasonal_model",
          displayName: "Seasonal Model",
          supportedPeriodType: "month",
          covariates: [
            { name: "rainfall", displayName: "Rainfall" },
            { name: "mean_temperature", displayName: "Mean temperature" },
          ],
          target: { name: "disease_cases", displayName: "Disease cases" },
        },
      ],
    });
  });

  it("falls back to name when displayName is missing", async () => {
    mockedChapGet.mockResolvedValueOnce({
      data: [{ id: 7, name: "auto_arima" }],
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as never,
    });

    const body = await getModels();

    expect(body.models).toEqual([
      { id: "7", name: "auto_arima", displayName: "auto_arima", covariates: [] },
    ]);
  });

  it("defaults covariates to an empty array when CHAP omits or malforms them", async () => {
    mockedChapGet.mockResolvedValueOnce({
      data: [
        { id: 1, name: "no_covariates" },
        { id: 2, name: "bad_covariates", covariates: "rainfall" },
        { id: 3, name: "partial_covariates", covariates: [{ displayName: "Nameless" }, null] },
      ],
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as never,
    });

    const body = await getModels();

    expect(body.models.map((model) => model.covariates)).toEqual([[], [], []]);
  });

  it("omits target when CHAP omits or malforms it", async () => {
    mockedChapGet.mockResolvedValueOnce({
      data: [
        { id: 1, name: "no_target" },
        { id: 2, name: "bad_target", target: "disease_cases" },
        { id: 3, name: "nameless_target", target: { displayName: "Nameless" } },
      ],
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as never,
    });

    const body = await getModels();

    expect(body.models.map((model) => "target" in model)).toEqual([false, false, false]);
  });

  it("returns empty models with error/code on CHAP failure", async () => {
    const axiosError = new AxiosError("Network Error");
    mockedChapGet.mockRejectedValueOnce(axiosError);

    const body = await getModels();

    expect(body.models).toEqual([]);
    expect(body.error).toBe("Network Error");
    expect(body.code).toBe("chap_unavailable");
  });

  it("returns empty models with generic error message on non-Axios failure", async () => {
    mockedChapGet.mockRejectedValueOnce(new Error("unexpected"));

    const body = await getModels();

    expect(body.models).toEqual([]);
    expect(body.error).toBe("CHAP is currently unreachable");
    expect(body.code).toBe("chap_unavailable");
  });

  it("returns empty models array when CHAP response data is not an array", async () => {
    mockedChapGet.mockResolvedValueOnce({
      data: null,
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as never,
    });

    const body = await getModels();

    expect(body.models).toEqual([]);
  });
});
