/** @fileoverview Inline-sized request splits for oversized results when no analytical workspace exists. @module services/canvas/inline-split */
import { requestedParameters } from '../power/normalize.js';
import type { ObservationRow, PowerDataset } from '../power/types.js';

/**
 * Per-call request changes that each fit inline, and the most rows one inline call of this shape
 * carries. `calls` is empty when no split of the request fits.
 */
export type InlineSplit = { inlineRows: number; calls: Record<string, unknown>[] };
/** Plans a split under the inline fit rule the success path applies to a complete response. */
export type SplitPlanner = (fits: (output: object) => boolean) => InlineSplit;

/** One re-sendable call: the request changes, its would-be inline output, and its row count. */
type Part = { patch: Record<string, unknown>; output: object; rows: number };
/**
 * Calls a request can split into: `groups` partitions sites, grid cells or parameters, and each
 * group's window splits into contiguous runs of `units` (days, years; one unit when the window
 * cannot split).
 */
type Layout = {
  groups: number;
  units: number;
  part(group: number, start: number, count: number, sliced: boolean): Part;
};

const DAY_MS = 86_400_000;

/** Request window fields the split reads. */
type WindowRequest = {
  temporalResolution: string;
  startDate?: string | undefined;
  endDate?: string | undefined;
  startYear?: number | undefined;
  endYear?: number | undefined;
};
/** Regional fields the split reads; every other envelope field is carried as-is. */
export type RegionShape = {
  request: WindowRequest & {
    latitudeMin: number;
    latitudeMax: number;
    longitudeMin: number;
    longitudeMax: number;
  };
  summaries: { periodKey: string }[];
  rows: ObservationRow[];
};

/** Window units and each row's unit index, derived from the request window and period keys. */
function windowUnits(request: WindowRequest) {
  const resolution = request.temporalResolution;
  if (resolution === 'hourly' || resolution === 'daily') {
    const start = Date.parse(request.startDate ?? '');
    const days = Array.from(
      { length: Math.floor((Date.parse(request.endDate ?? '') - start) / DAY_MS) + 1 },
      (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10),
    );
    const index = new Map(days.map((day, position) => [day.replaceAll('-', ''), position]));
    const unitOf = (key: string) => {
      const day = key.slice(0, 8);
      return index.get(day) ?? (day < (days[0] ?? '').replaceAll('-', '') ? 0 : days.length - 1);
    };
    return {
      units: days.length,
      rowUnit: (row: ObservationRow) => unitOf(row.periodKey),
      keyUnit: unitOf,
      patch: (start: number, count: number) => ({
        startDate: days[start],
        endDate: days[start + count - 1],
      }),
      years: (start: number, count: number) =>
        new Set(days.slice(start, start + count).map((day) => Number(day.slice(0, 4)))),
    };
  }
  if (resolution === 'monthly') {
    const first = request.startYear ?? 0;
    const units = Math.max(1, (request.endYear ?? first) - first + 1);
    const clamp = (year: number) => Math.min(units - 1, Math.max(0, year - first));
    return {
      units,
      rowUnit: (row: ObservationRow) => clamp(row.year ?? first),
      keyUnit: (key: string) => clamp(Number(key.slice(0, 4))),
      patch: (start: number, count: number) => ({
        startYear: first + start,
        endYear: first + start + count - 1,
      }),
      years: (start: number, count: number) =>
        new Set(Array.from({ length: count }, (_, index) => first + start + index)),
    };
  }
  return {
    units: 1,
    rowUnit: () => 0,
    keyUnit: () => 0,
    patch: () => ({}),
    years: () => new Set<number>(),
  };
}

/** Rows bucketed by window unit, preserving order within each unit. */
function byUnit(rows: ObservationRow[], units: number, rowUnit: (row: ObservationRow) => number) {
  const buckets: ObservationRow[][] = Array.from({ length: units }, () => []);
  for (const row of rows) buckets[rowUnit(row)]?.push(row);
  return buckets;
}

/** Contiguous, near-equal partition of `total` items into `parts` runs. */
function balanced(total: number, parts: number): { start: number; count: number }[] {
  return Array.from({ length: parts }, (_, index) => {
    const start = Math.floor((index * total) / parts);
    return { start, count: Math.floor(((index + 1) * total) / parts) - start };
  });
}

/** Largest count in 1..`limit` that fits, by doubling then bisecting; the caller has verified that 1 fits. */
function largestFit(limit: number, fitsAt: (count: number) => boolean): number {
  let low = 1;
  let high = 2;
  while (high <= limit && fitsAt(high)) {
    low = high;
    high *= 2;
  }
  high = Math.min(high, limit + 1);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fitsAt(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/** Largest row prefix that fits with the complete envelope; reported when no split fits. */
function prefixRows<T extends { rows: ObservationRow[] }>(
  dataset: T,
  fits: (output: object) => boolean,
): number {
  const fitsAt = (count: number) =>
    fits({ ...dataset, rows: dataset.rows.slice(0, count), rowCount: count, dataset: null });
  if (!dataset.rows.length || !fitsAt(1)) return 0;
  return largestFit(dataset.rows.length, fitsAt);
}

/**
 * Search each layout for the most window units one call carries, then verify every call of the
 * balanced split under the same fit rule. The first layout whose split verifies wins.
 */
function plan(layouts: Layout[], fits: (output: object) => boolean): InlineSplit | undefined {
  for (const layout of layouts) {
    const firstFits = (count: number) =>
      Array.from({ length: layout.groups }, (_, group) => group).every((group) =>
        fits(layout.part(group, 0, count, count < layout.units).output),
      );
    if (!firstFits(1)) continue;
    for (let perCall = largestFit(layout.units, firstFits); perCall >= 1; ) {
      const slices = balanced(layout.units, Math.ceil(layout.units / perCall));
      if (layout.groups === 1 && slices.length === 1) break;
      const parts = Array.from({ length: layout.groups }, (_, group) =>
        slices.map(({ start, count }) => layout.part(group, start, count, slices.length > 1)),
      ).flat();
      if (parts.every((part) => fits(part.output)))
        return {
          inlineRows: Math.max(
            ...Array.from(
              { length: layout.groups },
              (_, group) => layout.part(group, 0, perCall, true).rows,
            ),
          ),
          calls: parts.filter((part) => part.rows > 0).map((part) => part.patch),
        };
      perCall = Math.min(perCall - 1, Math.floor(perCall * 0.9));
    }
  }
  return undefined;
}

/** Without a shape-specific planner, report only the size and the inline prefix capacity. */
export function prefixSplit<T extends { rows: ObservationRow[] }>(dataset: T): SplitPlanner {
  return (fits) => ({ inlineRows: prefixRows(dataset, fits), calls: [] });
}

/** Point time series split by date or year window; climatology (and anything a window cannot fit) by parameter groups. */
export function pointSplit(dataset: PowerDataset): SplitPlanner {
  return (fits) => {
    const { request } = dataset;
    const window = windowUnits(request);
    const buckets = byUnit(dataset.rows, window.units, window.rowUnit);
    const codes = new Set(dataset.parameters.map((parameter) => parameter.code));
    /** Corrections follow siteElevation and wind settings, so every group keeps them. */
    const isCorrection = (code: string) => code === 'PSC' || code === 'WSC';
    const corrections = requestedParameters(request).filter(isCorrection);
    const selected = requestedParameters(request).filter((code) => !isCorrection(code));
    const columnsOf = (group: string[]) =>
      new Set([...group, ...corrections].flatMap((code) => dataset.expansions[code] ?? [code]));
    const part =
      (group: string[] | undefined) => (start: number, count: number, sliced: boolean) => {
        const columns = group ? columnsOf(group) : undefined;
        const project = (row: ObservationRow) =>
          columns
            ? Object.fromEntries(
                Object.entries(row).filter(([key]) => !codes.has(key) || columns.has(key)),
              )
            : row;
        const rows = buckets
          .slice(start, start + count)
          .flat()
          .map(project) as ObservationRow[];
        const patch = {
          ...(group ? { selection: { mode: 'parameters', parameters: group } } : {}),
          ...(sliced ? window.patch(start, count) : {}),
        };
        return {
          patch,
          rows: rows.length,
          output: {
            ...dataset,
            request: { ...request, ...patch },
            ...(columns
              ? {
                  parameters: dataset.parameters.filter((parameter) => columns.has(parameter.code)),
                  summaries: dataset.summaries.filter((summary) => columns.has(summary.parameter)),
                  expansions: Object.fromEntries(
                    Object.entries(dataset.expansions).filter(([code]) => group?.includes(code)),
                  ),
                  omittedParameters: dataset.omittedParameters.filter((omitted) =>
                    group?.includes(omitted.code),
                  ),
                }
              : {}),
            rows,
            rowCount: rows.length,
            dataset: null,
          },
        };
      };
    const whole = plan(
      [
        {
          groups: 1,
          units: window.units,
          part: (_group, start, count, sliced) => part(undefined)(start, count, sliced),
        },
      ],
      fits,
    );
    if (whole) return whole;
    /** Pack requested codes greedily into groups whose single window unit fits. */
    const groups: string[][] = [];
    for (const code of selected) {
      const current = groups.at(-1);
      if (current && fits(part([...current, code])(0, 1, window.units > 1).output))
        current.push(code);
      else groups.push([code]);
    }
    const grouped =
      groups.length > 1
        ? plan(
            [
              {
                groups: groups.length,
                units: window.units,
                part: (group, start, count, sliced) =>
                  part(groups[group] ?? [])(start, count, sliced),
              },
            ],
            fits,
          )
        : undefined;
    return grouped ?? { inlineRows: prefixRows(dataset, fits), calls: [] };
  };
}

/**
 * Regional split by date or year window, then by sub-boxes that partition the box's grid cells
 * and keep every axis at least 2° wide.
 */
export function regionSplit<T extends RegionShape>(dataset: T): SplitPlanner {
  return (fits) => {
    const { request } = dataset;
    const window = windowUnits(request);
    const buckets = byUnit(dataset.rows, window.units, window.rowUnit);
    const cells = new Map<string, { latitude: number; longitude: number }>();
    for (const row of dataset.rows)
      if (typeof row.cellId === 'string' && !cells.has(row.cellId))
        cells.set(row.cellId, { latitude: row.latitude, longitude: row.longitude });
    const latSpan = request.latitudeMax - request.latitudeMin;
    const lonSpan = request.longitudeMax - request.longitudeMin;
    const axis = (key: 'latitude' | 'longitude') =>
      [...new Set([...cells.values()].map((cell) => cell[key]))].sort((x, y) => x - y);
    const coordinates = { latitude: axis('latitude'), longitude: axis('longitude') };
    /**
     * POWER returns a cell when its center lies within the inclusive bounds, so adjacent tiles
     * share an interior bound at the midpoint between their neighboring returned coordinates:
     * no center sits on it, each cell lands in exactly one tile, and no grid step is assumed.
     * The outer tiles keep the box edges. Undefined when a part would span under 2°.
     */
    const cut = (values: number[], min: number, max: number, parts: number) => {
      if (parts === 1) return [[min, max] as const];
      if (values.length < parts) return;
      const bounds = [
        min,
        ...balanced(values.length, parts)
          .slice(1)
          .map(({ start }) => ((values[start - 1] ?? min) + (values[start] ?? max)) / 2),
        max,
      ];
      const ranges = bounds.slice(1).map((high, index) => [bounds[index] ?? min, high] as const);
      return ranges.every(([low, high]) => high - low >= 2) ? ranges : undefined;
    };
    const grids: [number, number][] = [];
    for (let a = 1; latSpan / a >= 2; a++)
      for (let b = 1; lonSpan / b >= 2; b++) grids.push([a, b]);
    grids.sort((x, y) => x[0] * x[1] - y[0] * y[1] || x[0] - y[0]);
    const layouts: Layout[] = [];
    for (const [a, b] of grids) {
      const lat = cut(coordinates.latitude, request.latitudeMin, request.latitudeMax, a);
      const lon = cut(coordinates.longitude, request.longitudeMin, request.longitudeMax, b);
      if (!lat || !lon) continue;
      const tiles = Array.from({ length: a * b }, (_, index) => {
        const [latitudeMin, latitudeMax] = lat[Math.floor(index / b)] ?? [0, 0];
        const [longitudeMin, longitudeMax] = lon[index % b] ?? [0, 0];
        const bounds = { latitudeMin, latitudeMax, longitudeMin, longitudeMax };
        const members = new Set(
          [...cells]
            .filter(
              ([, cell]) =>
                cell.latitude >= bounds.latitudeMin - 1e-9 &&
                cell.latitude <= bounds.latitudeMax + 1e-9 &&
                cell.longitude >= bounds.longitudeMin - 1e-9 &&
                cell.longitude <= bounds.longitudeMax + 1e-9,
            )
            .map(([id]) => id),
        );
        return { bounds, members };
      });
      const tiled = a * b > 1;
      layouts.push({
        groups: tiles.length,
        units: window.units,
        part: (group, start, count, sliced) => {
          const tile = tiles[group] ?? { bounds: {}, members: new Set<string>() };
          const rows = buckets
            .slice(start, start + count)
            .flat()
            .filter((row) => tile.members.has(String(row.cellId)));
          const patch = {
            ...(tiled ? tile.bounds : {}),
            ...(sliced ? window.patch(start, count) : {}),
          };
          return {
            patch,
            rows: rows.length,
            output: {
              ...dataset,
              request: { ...request, ...patch },
              cellCount: tile.members.size,
              summaries: dataset.summaries.filter((summary) => {
                const unit = window.keyUnit(summary.periodKey);
                return unit >= start && unit < start + count;
              }),
              rows,
              rowCount: rows.length,
              dataset: null,
            },
          };
        },
      });
    }
    return plan(layouts, fits) ?? { inlineRows: prefixRows(dataset, fits), calls: [] };
  };
}

/** Comparison fields the split reads; every other envelope field is carried as-is. */
export type ComparisonShape = {
  request: WindowRequest & { locations: object[] };
  metadata: { endpointUrls: string[] } & Record<string, unknown>;
  locations: { locationId: string; metadata: { endpointUrl: string } }[];
  failed: { locationId: string }[];
  summaries: { locationId: string; year: number | null }[];
  possibleSharedGridCell: string[][];
  rows: ObservationRow[];
};

/** Comparison split by date or year window, then by contiguous groups of at least two input sites. */
export function comparisonSplit<T extends ComparisonShape>(dataset: T): SplitPlanner {
  return (fits) => {
    const { request } = dataset;
    const window = windowUnits(request);
    const buckets = byUnit(dataset.rows, window.units, window.rowUnit);
    const sites = request.locations.map((location, index) => ({
      location,
      id: `location_${index + 1}`,
    }));
    const layouts: Layout[] = [];
    for (let groups = 1; sites.length / groups >= 2; groups++) {
      const members = balanced(sites.length, groups).map(({ start, count }) =>
        sites.slice(start, start + count),
      );
      layouts.push({
        groups,
        units: window.units,
        part: (group, start, count, sliced) => {
          const chosen = members[group] ?? [];
          const ids = new Set(chosen.map((site) => site.id));
          const years = window.years(start, count);
          const locations = dataset.locations.filter((location) => ids.has(location.locationId));
          const rows = buckets
            .slice(start, start + count)
            .flat()
            .filter((row) => ids.has(String(row.locationId)));
          const failed = dataset.failed.filter((failure) => ids.has(failure.locationId));
          const patch = {
            ...(groups > 1 ? { locations: chosen.map((site) => site.location) } : {}),
            ...(sliced ? window.patch(start, count) : {}),
          };
          return {
            patch,
            rows: rows.length,
            output: {
              ...dataset,
              request: { ...request, ...patch },
              metadata: {
                ...dataset.metadata,
                endpointUrls: locations.map((location) => location.metadata.endpointUrl),
              },
              locations,
              failed,
              partial: failed.length > 0,
              summaries: dataset.summaries.filter(
                (summary) =>
                  ids.has(summary.locationId) &&
                  (!sliced || summary.year === null || years.has(summary.year)),
              ),
              possibleSharedGridCell: dataset.possibleSharedGridCell
                .map((shared) => shared.filter((id) => ids.has(id)))
                .filter((shared) => shared.length > 1),
              rows,
              rowCount: rows.length,
              dataset: null,
            },
          };
        },
      });
    }
    return plan(layouts, fits) ?? { inlineRows: prefixRows(dataset, fits), calls: [] };
  };
}

/** Caller-facing recovery naming the measured size, the inline capacity and the split. */
export function splitRecovery(rowCount: number, split: InlineSplit): string {
  if (split.inlineRows === 0)
    return `The complete result has ${rowCount} rows, and not even one row of this request fits inline with its metadata. Request fewer parameters per call, or fewer sites per call for a comparison, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb to stage it whole.`;
  const size = `The complete result has ${rowCount} rows and at most ${split.inlineRows} fit inline in one call.`;
  if (!split.calls.length)
    return `${size} No split of this request fits inline; request fewer parameters or a smaller window, region or site list, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb to stage it whole.`;
  const fields = [...new Set(split.calls.flatMap((call) => Object.keys(call)))];
  const named =
    fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}` : fields[0];
  return `${size} Re-send it as the ${split.calls.length} calls listed in calls, each changing only ${named} and each fitting inline, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb to stage it whole.`;
}
