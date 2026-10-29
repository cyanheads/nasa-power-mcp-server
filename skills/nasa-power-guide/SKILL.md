---
name: nasa-power-guide
description: Plan nasa_power_* calls for NASA POWER solar, wind, temperature, precipitation, and degree-day history. Covers which tool answers a typical-month versus a dated question, one data call at a time, grid-cell size, data freshness, rate versus total units, degree days, and SQL over staged tables. Use before solar sizing, wind screening, site comparison, regional, or agroclimate work with these tools.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

NASA POWER serves historical gridded estimates (reanalysis and satellite products), keyless. It does not serve forecasts or station measurements, and its newest days are not available yet (see the freshness gate below). The data tools take latitude and longitude only, so geocode a place name before calling.

Values describe grid cells, not the exact point:

| Family | Cell size |
|:--|:--|
| Meteorology (temperature, humidity, wind, precipitation, degree days) | 0.5° latitude × 0.625° longitude |
| Solar irradiance | 1° × 1° |

Sites that fall in the same cell return identical values. The `returnedCoordinates` in metadata echo the request; they are not the cell center.

## Identifiers

- **Parameter codes** come from `nasa_power_search_parameters` for one community and temporalResolution pair. A code valid at daily can be missing at hourly: degree days, `T2M_MAX` and `T2M_MIN` have no hourly form. Filter with plain words, for example `degree days` or `wind 50`.
- **Preset names and the `SI_EF_TILTED_SURFACE` alias** (climatology only) come from `nasa_power_list_reference` topic `presets`.
- **`canvas_id` and table names** come from the handles on a producing response: `dataset` for observations, `summaryDataset` for regional summaries, `summaryDatasets.buckets` and `summaryDatasets.locations` for comparison summaries.
- **`locationId`, `label` and `cellId`** are row columns. `locationId` follows input position (`location_1` …), and `cellId` numbers the cells in a regional result.

## Gates

1. **One data call at a time.** `nasa_power_get_timeseries`, `nasa_power_get_climatology`, `nasa_power_get_region` and `nasa_power_compare_locations` share one admission budget. While one is running, another call is refused immediately with `canvas_capacity_exhausted`, however small it is. Its recovery text about canvases does not apply here: wait for the running call to return, then retry. For several sites, use one `nasa_power_compare_locations` call (up to 10 sites) instead of parallel point calls.
2. **Check freshness before you conclude.** The latest days of a window come back as nulls until NASA releases them, and solar can lag meteorology. Read `summaries[].lastValidDate` for each parameter. Never report trailing nulls as zero, as calm, or as "no sun".
3. **Same cell, not a tie.** When `nasa_power_compare_locations` returns `possibleSharedGridCell`, the listed sites sit in one cell. Report them as indistinguishable, not as equal results.
4. **Rate or total.** Check what a value measures before summing or comparing:
   - `PRECTOTCORR` is mm/day at every resolution. Monthly values, `YYYY13` and climatology months and `ANN` are mean daily rates, so multiply by the number of days for a total.
   - Solar units follow the community: `RE` returns kW-hr/m^2/day and `AG` returns MJ/m^2/day for the same code.
   - Degree-day codes (`GDD*`, `HDD*`, `CDD*`) are totals for their period: per day, per month, and per year for `ANN` and `YYYY13`.
   - Temperature, humidity and wind annual records are means.
5. **Degree days come from NASA.** Growing degree days are source codes `GDD4_4`, `GDD7_2`, `GDD10`, `GDD13_3` and `GDD15_6` (base °C), alongside `HDD*` and `CDD*`. Request them; don't rebuild them from `T2M`. The dictionary also lists `GDD*` at monthly and climatology, but NASA's monthly and climatology endpoints fail on them with HTTP 500. Request `GDD*` at daily and sum the days.
6. **Annual rows sit inside monthly data.** Monthly results add one annual record per year (`periodKind` `annual`, `month` null, key `YYYY13`), and climatology adds `ANN`. Exclude these rows before averaging or ranking months.
7. **A regional box spans at least 2° on each axis.** For a smaller area, use a point call. The box returns one parameter per call, so make sequential calls for several parameters (gate 1).
8. **Summaries are coarse.** `summaries` aggregate each period kind over the whole window. Comparison buckets are calendar-season means (DJF, MAM, JJA, SON, annual): they don't accumulate and don't follow a growing season. For any other grouping or any sum, compute it from the inline rows or with SQL.

## Workflows

### Picking the call

| Question | Call |
|:--|:--|
| Typical month or year: PV sizing, the calmest month, annual heating load | `nasa_power_get_climatology`. The default period is stated in `metadata.range`. Pass `startYear` with `endYear` for a custom multi-year window, which returns `JAN`…`DEC` plus `ANN` in one small response. |
| Specific dates, day-level distributions, seasonal accumulations | `nasa_power_get_timeseries` at daily (or hourly from 2001) |
| The same question at 2–10 sites | `nasa_power_compare_locations` |
| A spatial pattern | `nasa_power_get_region` |

**PV sizing:** call climatology with community `RE` and `SI_EF_TILTED_SURFACE` (add `ALLSKY_SFC_SW_DWN` for the horizontal baseline). Irradiance arrives in kW-hr/m^2/day, which equals peak sun hours, for horizontal, latitude, latitude ±15°, vertical and optimal tilts. `SI_TILTED_AVG_OPTIMAL_ANG` is the optimal tilt in degrees, and `SI_TILTED_AVG_OPTIMAL_ANG_ORT` is facing text such as `S`.

**Season totals at several farms** (growing degree days, rainfall): run `nasa_power_compare_locations` at daily for the season's dates, then `SUM` per `label` in SQL. Bucket means don't give totals. A daily `PRECTOTCORR` value is that day's total in mm, so the daily values add up directly.

### Staged tables and SQL

Staging is automatic. A data call stages only when the complete response would not fit inline. Smaller results come back inline with `dataset: null`, even when you pass `canvas_id`, and you compute from those rows directly.

Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `nasa_power_dataframe_describe` with it for the staged table and column names before writing SQL, then `nasa_power_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; each table expires at the `expiresAt` on its handle.

- **Dialect.** DuckDB. Reference tables by the exact `power_…` name from the handle.
- **Observation columns.** `periodKey`, `periodKind`, `date`, `year`, `month`, `hour`, `latitude`, `longitude`, `elevation`, then one column per returned parameter code. Comparison tables add `locationId` and `label`; regional tables add `cellId`.
- **Dates.** `date` is VARCHAR (`YYYY-MM-DD` on daily and monthly rows, null on annual and climatology rows), so use `CAST(date AS DATE)` before date functions.
- **Nulls.** Missing values are NULL, and `AVG` and `SUM` skip them. Compare `count(column)` with the number of days you expected before trusting a total.
- **Integer results.** Integer-typed results such as `COUNT` come back as strings. Wrap them in `CAST(… AS INTEGER)` when you need a number; aggregates over measured parameters are numeric.
- **Shared canvas.** Reuse one `canvas_id` across the data calls in a task. The tables then share a canvas and can be joined in one SELECT, and you don't spend the limited canvas capacity on a fresh canvas per call.
- **Expiry.** Tables expire. After `canvas_not_found` or `missing_table`, rerun the producing call without the old `canvas_id` (a stale token fails again) to stage the data in a fresh canvas.
- **Row limit.** `rowLimit` defaults to 100 rows. Aggregate in SQL rather than paging raw rows.
