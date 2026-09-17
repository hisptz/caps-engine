# CAPS domain glossary

## Climate OGC integration

- **Dataset** — Managed dataset identifier stored as `datasetId` in the `climate-openeo-create` handler config (e.g. `era5land_precipitation_monthly`).
- **Coverage request** — `GET /ogcapi/collections/{collectionId}/coverage` with `f=zarr`, `datetime`, and `bbox`. The response body is a **ZIP archive** containing a Zarr store directory tree.
- **Organisation unit feature** — DHIS2 organisation unit with geometry from `getOrgUnitsGeoJSON`; its bounding box is sent as the coverage `bbox` parameter and its id becomes `orgUnit` on each output `DataValue`.

## Malaria threshold generation

- **Threshold** — Epidemiological alert line for a given organisation unit and reporting period, derived from historical case data and uploaded to DHIS2 as a `DataValue`.
- **C-SUM (cumulative sum method)** — WHO smoothed baseline: the mean of case counts in a three-period window (previous, target, and next sub-period) pooled across the baseline years. Not a running sum within a single year.
- **C-SUM SD** — Population standard deviation of the same pooled window values used for the C-SUM baseline.
- **C-SUM + 1.96SD** — Upper 95% confidence limit for the C-SUM baseline (mean + 1.96 × SD on the pooled window values).
- **First quartile / 25th percentile** — Lower bound of the “normal channel”: the 25th percentile of the same epidemiological sub-period over baseline years (for five years, equivalent to the second-lowest observation).
- **Third quartile / 75th percentile** — Upper bound of the “normal channel”: the 75th percentile of the same epidemiological sub-period over baseline years (for five years, equivalent to the second-highest observation).
