/** @fileoverview Observation, grid-cell and fixed-season arithmetic summaries. @module services/power/summarize */
import type { MissingProvenance } from './normalize.js';
import type {
  BucketSummary,
  CellSummary,
  NumericSummary,
  ObservationRow,
  ParameterMetadata,
  PowerDataset,
  PowerRequest,
} from './types.js';

function stats(values: number[]) {
  if (!values.length) return { mean: null, min: null, max: null };
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { mean: sum / values.length, min, max };
}
/** Summaries use the union of actually returned keys, never an invented calendar. */
export function summarizeRows(
  rows: ObservationRow[],
  parameters: ParameterMetadata[],
  missing: MissingProvenance = new Map(),
): NumericSummary[] {
  const summaries: NumericSummary[] = [];
  for (const parameter of parameters.filter((parameter) => parameter.valueKind === 'number')) {
    for (const kind of new Set(rows.map((row) => row.periodKind))) {
      const group = rows.filter((row) => row.periodKind === kind);
      const valid = group.filter((row) => typeof row[parameter.code] === 'number');
      const values = valid.map((row) => row[parameter.code] as number);
      const absentKeyCount = group.filter(
        (row) => missing.get(parameter.code)?.get(row.periodKey) === 'absent',
      ).length;
      const missingCount = group.length - valid.length;
      const last = valid.at(-1);
      summaries.push({
        parameter: parameter.code,
        periodKind: kind,
        ...(parameter.units !== undefined ? { units: parameter.units } : {}),
        validCount: valid.length,
        missingCount,
        absentKeyCount,
        fillCount: missingCount - absentKeyCount,
        firstReturnedKey: group[0]?.periodKey ?? null,
        lastReturnedKey: group.at(-1)?.periodKey ?? null,
        lastValidPeriodKey: last?.periodKey ?? null,
        lastValidDate: last?.date ?? null,
        ...stats(values),
      });
    }
  }
  return summaries;
}
/** Cross-cell statistics compare only the same parameter and period key. */
export function summarizeCells(
  rows: ObservationRow[],
  parameters: ParameterMetadata[],
  cellCount = new Set(rows.map((row) => row.cellId)).size,
): CellSummary[] {
  const periods = new Map<string, { kind: ObservationRow['periodKind']; rows: ObservationRow[] }>();
  for (const row of rows) {
    const group = periods.get(row.periodKey) ?? { kind: row.periodKind, rows: [] };
    group.rows.push(row);
    periods.set(row.periodKey, group);
  }
  return parameters
    .filter((parameter) => parameter.valueKind === 'number')
    .flatMap((parameter) =>
      [...periods].map(([periodKey, { kind, rows: group }]) => {
        const values = group.flatMap((row) =>
          typeof row[parameter.code] === 'number' ? [row[parameter.code] as number] : [],
        );
        return {
          parameter: parameter.code,
          periodKey,
          periodKind: kind,
          ...(parameter.units !== undefined ? { units: parameter.units } : {}),
          validCellCount: values.length,
          missingCellCount: cellCount - values.length,
          ...stats(values),
        };
      }),
    );
}
const seasonMonths = { DJF: [12, 1, 2], MAM: [3, 4, 5], JJA: [6, 7, 8], SON: [9, 10, 11] } as const;
const dayMs = 86_400_000;
function windowBounds(request: PowerRequest): [number, number] | null {
  if (request.temporalResolution === 'climatology') return null;
  if (request.temporalResolution === 'monthly')
    return [Date.UTC(request.startYear, 0, 1), Date.UTC(request.endYear + 1, 0, 1)];
  return [Date.parse(request.startDate), Date.parse(request.endDate) + dayMs];
}
/** Annual/season means disclose full-calendar expectations and clipped windows. */
export function summarizeBuckets(dataset: PowerDataset, locationId: string): BucketSummary[] {
  const { request, rows, parameters } = dataset;
  const climatology = request.temporalResolution === 'climatology';
  const bounds = windowBounds(request);
  const firstYear = bounds ? new Date(bounds[0]).getUTCFullYear() : 0;
  const lastYear = bounds ? new Date(bounds[1] - 1).getUTCFullYear() : 0;
  const specs: {
    bucket: BucketSummary['bucket'];
    year: number | null;
    start: number;
    end: number;
    months: readonly number[];
  }[] = [];
  for (let year = firstYear; year <= lastYear + (climatology ? 0 : 1); year++) {
    if (year <= lastYear)
      specs.push({
        bucket: 'annual',
        year: climatology ? null : year,
        start: Date.UTC(year, 0, 1),
        end: Date.UTC(year + 1, 0, 1),
        months: [],
      });
    for (const bucket of ['DJF', 'MAM', 'JJA', 'SON'] as const) {
      const months = seasonMonths[bucket];
      const start = Date.UTC(year - (bucket === 'DJF' ? 1 : 0), months[0] - 1, 1);
      const end = bucket === 'DJF' ? Date.UTC(year, 2, 1) : Date.UTC(year, months[2], 1);
      if (!bounds || (start < bounds[1] && end > bounds[0]))
        specs.push({
          bucket,
          year: climatology ? null : year,
          start,
          end,
          months,
        });
    }
  }
  return parameters
    .filter((parameter) => parameter.valueKind === 'number')
    .flatMap((parameter) =>
      specs.map((spec) => {
        const annual = spec.bucket === 'annual';
        const sourceAnnual = annual && (climatology || request.temporalResolution === 'monthly');
        const group = rows.filter((row) => {
          if (sourceAnnual)
            return (
              row.periodKind === (climatology ? 'climatology_annual' : 'annual') &&
              (climatology || row.year === spec.year)
            );
          if (climatology)
            return row.periodKind === 'climatology_month' && spec.months.includes(row.month ?? 0);
          if (row.periodKind === 'annual' || !row.date) return false;
          const stamp = Date.parse(row.date.length === 19 ? `${row.date}Z` : row.date);
          return stamp >= spec.start && stamp < spec.end;
        });
        const values = group.flatMap((row) =>
          typeof row[parameter.code] === 'number' ? [row[parameter.code] as number] : [],
        );
        const expectedPeriods = sourceAnnual
          ? 1
          : climatology || request.temporalResolution === 'monthly'
            ? 3
            : Math.round((spec.end - spec.start) / dayMs) *
              (request.temporalResolution === 'hourly' ? 24 : 1);
        return {
          parameter: parameter.code,
          locationId,
          ...(parameter.units !== undefined ? { units: parameter.units } : {}),
          bucket: spec.bucket,
          year: spec.year,
          method: sourceAnnual
            ? 'source_annual'
            : climatology
              ? 'climatology_month_mean'
              : request.temporalResolution === 'monthly'
                ? 'monthly_mean'
                : 'observation_mean',
          includedPeriods: values.length,
          returnedPeriods: group.length,
          expectedPeriods,
          complete: values.length === expectedPeriods,
          windowClipped: bounds !== null && (spec.start < bounds[0] || spec.end > bounds[1]),
          mean: stats(values).mean,
        };
      }),
    );
}
/** Pure comparison preparation; scheduling/failure orchestration belongs to tools. */
export function compareDatasets(datasets: { locationId: string; dataset: PowerDataset }[]): {
  summaries: BucketSummary[];
  comparable: boolean;
  sortMetrics: { locationId: string; parameter: string; mean: number | null }[];
} {
  const units = new Map<string, Set<string | undefined>>();
  for (const { dataset } of datasets)
    for (const parameter of dataset.parameters) {
      const observed = units.get(parameter.code) ?? new Set();
      observed.add(parameter.units);
      units.set(parameter.code, observed);
    }
  const comparable = [...units.values()].every(
    (observed) => observed.size === 1 && !observed.has(undefined),
  );
  return {
    comparable,
    summaries: datasets.flatMap(({ locationId, dataset }) => summarizeBuckets(dataset, locationId)),
    sortMetrics: datasets.flatMap(({ locationId, dataset }) =>
      dataset.parameters
        .filter((parameter) => parameter.valueKind === 'number')
        .map((parameter) => {
          const summaries = dataset.summaries.filter(
            (summary) =>
              summary.parameter === parameter.code &&
              (dataset.request.temporalResolution === 'monthly'
                ? summary.periodKind === 'annual'
                : dataset.request.temporalResolution === 'climatology'
                  ? summary.periodKind === 'climatology_annual'
                  : true),
          );
          const valid = summaries.filter(
            (summary): summary is NumericSummary & { mean: number } =>
              summary.mean !== null && summary.validCount > 0,
          );
          const count = valid.reduce((sum, summary) => sum + summary.validCount, 0);
          return {
            locationId,
            parameter: parameter.code,
            mean:
              units.get(parameter.code)?.size === 1 &&
              !units.get(parameter.code)?.has(undefined) &&
              count
                ? valid.reduce((sum, summary) => sum + summary.mean * summary.validCount, 0) / count
                : null,
          };
        }),
    ),
  };
}
