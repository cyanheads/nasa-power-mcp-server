/** @fileoverview Inline-sized request splits planned under a supplied fit rule. @module tests/services/canvas/inline-split */
import { describe, expect, it } from 'vitest';
import {
  type ComparisonShape,
  comparisonSplit,
  pointSplit,
  prefixSplit,
  type RegionShape,
  regionSplit,
  splitRecovery,
} from '@/services/canvas/inline-split.js';
import type { ObservationRow, PowerDataset } from '@/services/power/types.js';

const DAY_MS = 86_400_000;
type Output = { rows: Record<string, unknown>[] };
/** Fit rule by row count alone, so expected splits are exact. */
const rowsAtMost = (cap: number) => (output: object) => (output as Output).rows.length <= cap;
const days = (start: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(start) + i * DAY_MS).toISOString().slice(0, 10).replaceAll('-', ''),
  );
function point(request: Record<string, unknown>, keys: string[], codes = ['T2M']) {
  const rows = keys.map((periodKey) => ({
    periodKey,
    year: Number(periodKey.slice(0, 4)),
    ...Object.fromEntries(codes.map((code) => [code, 1])),
  }));
  return {
    request: { selection: { mode: 'parameters', parameters: codes }, ...request },
    rows,
    parameters: codes.map((code) => ({ code })),
    summaries: codes.map((parameter) => ({ parameter })),
    expansions: {},
    omittedParameters: [],
  } as unknown as PowerDataset;
}

describe('pointSplit', () => {
  it('splits a daily window into contiguous, balanced date windows', () => {
    const dataset = point(
      { temporalResolution: 'daily', startDate: '2024-01-01', endDate: '2024-01-10' },
      days('2024-01-01', 10),
    );
    expect(pointSplit(dataset)(rowsAtMost(4))).toEqual({
      inlineRows: 4,
      calls: [
        { startDate: '2024-01-01', endDate: '2024-01-03' },
        { startDate: '2024-01-04', endDate: '2024-01-06' },
        { startDate: '2024-01-07', endDate: '2024-01-10' },
      ],
    });
  });

  it('splits an hourly window by whole days', () => {
    const keys = days('2024-02-28', 3).flatMap((day) =>
      Array.from({ length: 24 }, (_, hour) => `${day}${String(hour).padStart(2, '0')}`),
    );
    const dataset = point(
      { temporalResolution: 'hourly', startDate: '2024-02-28', endDate: '2024-03-01' },
      keys,
    );
    expect(pointSplit(dataset)(rowsAtMost(30))).toEqual({
      inlineRows: 24,
      calls: [
        { startDate: '2024-02-28', endDate: '2024-02-28' },
        { startDate: '2024-02-29', endDate: '2024-02-29' },
        { startDate: '2024-03-01', endDate: '2024-03-01' },
      ],
    });
  });

  it('splits a monthly window by whole years, annual records included', () => {
    const keys = [2019, 2020, 2021].flatMap((year) =>
      Array.from({ length: 13 }, (_, month) => `${year}${String(month + 1).padStart(2, '0')}`),
    );
    const dataset = point({ temporalResolution: 'monthly', startYear: 2019, endYear: 2021 }, keys);
    expect(pointSplit(dataset)(rowsAtMost(20))).toEqual({
      inlineRows: 13,
      calls: [
        { startYear: 2019, endYear: 2019 },
        { startYear: 2020, endYear: 2020 },
        { startYear: 2021, endYear: 2021 },
      ],
    });
  });

  it('splits a climatology too wide for one call into parameter groups, keeping corrections in each', () => {
    const codes = ['A', 'B', 'C', 'D'];
    const dataset = point(
      { temporalResolution: 'climatology', siteElevation: 10 },
      [
        ...['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
        'ANN',
      ],
      [...codes, 'PSC'],
    );
    dataset.request = { ...dataset.request, selection: { mode: 'parameters', parameters: codes } };
    const seen: Output[] = [];
    /** At most three value columns per row: two selected codes plus the PSC correction. */
    const fits = (output: object) => {
      seen.push(output as Output);
      return (output as Output).rows.every(
        (row) => Object.keys(row).filter((key) => key === 'PSC' || codes.includes(key)).length <= 3,
      );
    };
    expect(pointSplit(dataset)(fits)).toEqual({
      inlineRows: 13,
      calls: [
        { selection: { mode: 'parameters', parameters: ['A', 'B'] } },
        { selection: { mode: 'parameters', parameters: ['C', 'D'] } },
      ],
    });
    const verified = seen.filter((output) => output.rows.length && 'PSC' in (output.rows[0] ?? {}));
    expect(verified.length).toBeGreaterThan(0);
  });

  it('returns no calls and the whole row count when the result already fits', () => {
    const dataset = point(
      { temporalResolution: 'daily', startDate: '2024-01-01', endDate: '2024-01-10' },
      days('2024-01-01', 10),
    );
    expect(pointSplit(dataset)(() => true)).toEqual({ inlineRows: 10, calls: [] });
  });

  it('returns no calls and zero capacity when not even one row fits', () => {
    const dataset = point(
      { temporalResolution: 'daily', startDate: '2024-01-01', endDate: '2024-01-10' },
      days('2024-01-01', 10),
    );
    expect(pointSplit(dataset)(() => false)).toEqual({ inlineRows: 0, calls: [] });
  });
});

describe('prefixSplit', () => {
  it('reports the largest inline row prefix and no calls', () => {
    const dataset = point({ temporalResolution: 'daily' }, days('2024-01-01', 10));
    expect(prefixSplit(dataset)(rowsAtMost(7))).toEqual({ inlineRows: 7, calls: [] });
  });
});

/** Grid points of the 0.5° × 0.625° native grid inside an inclusive range. */
const grid = (min: number, max: number, step: number, origin: number) => {
  const points: number[] = [];
  for (let i = Math.ceil((min - origin) / step - 1e-9); origin + i * step <= max + 1e-9; i++)
    points.push(Number((origin + i * step).toFixed(4)));
  return points;
};
function region(
  bounds: Record<'latitudeMin' | 'latitudeMax' | 'longitudeMin' | 'longitudeMax', number>,
) {
  const periods = [
    ...['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
    'ANN',
  ];
  const cells = grid(bounds.latitudeMin, bounds.latitudeMax, 0.5, -90).flatMap((latitude) =>
    grid(bounds.longitudeMin, bounds.longitudeMax, 0.625, -180).map((longitude) => ({
      latitude,
      longitude,
    })),
  );
  const rows = cells.flatMap((cell, index) =>
    periods.map((periodKey) => ({ ...cell, cellId: `cell_${index + 1}`, periodKey, T2M: 1 })),
  ) as unknown as ObservationRow[];
  return {
    request: { temporalResolution: 'climatology', ...bounds },
    summaries: periods.map((periodKey) => ({ periodKey })),
    rows,
    cells,
  } satisfies RegionShape & { cells: unknown[] };
}

describe('regionSplit', () => {
  const box = { latitudeMin: 40, latitudeMax: 46, longitudeMin: -124, longitudeMax: -118 };

  it('tiles a region into the smallest grid of sub-boxes at least 2° per axis that fits', () => {
    const dataset = region(box);
    /**
     * 13 latitudes (40 to 46) × 10 longitudes (−123.75 to −118.125) × 13 periods. The 1×2 and 2×1
     * tilings leave a tile over 600 rows; 1×3 and 3×1 would cut a part narrower than 2°.
     */
    expect(dataset.rows).toHaveLength(1690);
    const split = regionSplit(dataset)(rowsAtMost(600));
    /**
     * Each next tile starts one grid step past the previous tile's last cell (0.5° latitude,
     * 0.625° longitude); the outer tiles keep the box edges.
     */
    expect(split).toEqual({
      inlineRows: 455,
      calls: [
        { latitudeMin: 40, latitudeMax: 42.5, longitudeMin: -124, longitudeMax: -121.25 },
        { latitudeMin: 40, latitudeMax: 42.5, longitudeMin: -120.625, longitudeMax: -118 },
        { latitudeMin: 43, latitudeMax: 46, longitudeMin: -124, longitudeMax: -121.25 },
        { latitudeMin: 43, latitudeMax: 46, longitudeMin: -120.625, longitudeMax: -118 },
      ],
    });
    /** Under inclusive bounds, as POWER applies them, every cell falls in exactly one tile. */
    const holders = (cell: { latitude: number; longitude: number }) =>
      split.calls.filter(
        (call) =>
          cell.latitude >= (call.latitudeMin as number) &&
          cell.latitude <= (call.latitudeMax as number) &&
          cell.longitude >= (call.longitudeMin as number) &&
          cell.longitude <= (call.longitudeMax as number),
      ).length;
    expect(dataset.cells.map(holders)).toEqual(dataset.cells.map(() => 1));
  });

  it('cuts an off-grid box between its cells, keeping each tile at least 2°', () => {
    /** 10 latitudes (40.5 to 45) × 4 longitudes (−121.875 to −120); longitude spans only 2°. */
    const dataset = region({
      latitudeMin: 40.2,
      latitudeMax: 45.2,
      longitudeMin: -122,
      longitudeMax: -120,
    });
    expect(dataset.rows).toHaveLength(520);
    expect(regionSplit(dataset)(rowsAtMost(300))).toEqual({
      inlineRows: 260,
      calls: [
        { latitudeMin: 40.2, latitudeMax: 42.5, longitudeMin: -122, longitudeMax: -120 },
        { latitudeMin: 43, latitudeMax: 45.2, longitudeMin: -122, longitudeMax: -120 },
      ],
    });
  });

  it('does not cut an axis whose parts would drop below 2°, even when the span is at least 4°', () => {
    /** 9 latitudes (40.5 to 44.5): any cut between cells leaves one side under 2° (40.2–42, 42.5–44.7). */
    const dataset = region({
      latitudeMin: 40.2,
      latitudeMax: 44.7,
      longitudeMin: -122,
      longitudeMax: -120,
    });
    expect(dataset.rows).toHaveLength(468);
    expect(regionSplit(dataset)(rowsAtMost(300))).toEqual({ inlineRows: 300, calls: [] });
  });

  it('never offers a tile narrower than 2°, so a minimal box that does not fit has no split', () => {
    const dataset = region({
      latitudeMin: 40,
      latitudeMax: 42,
      longitudeMin: -122,
      longitudeMax: -120,
    });
    expect(dataset.rows).toHaveLength(260);
    expect(regionSplit(dataset)(rowsAtMost(200))).toEqual({ inlineRows: 200, calls: [] });
  });
});

function comparison(sites: number) {
  const periods = [
    ...['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
    'ANN',
  ];
  const locations = Array.from({ length: sites }, (_, i) => ({
    latitude: i,
    longitude: i,
    label: `site ${i}`,
  }));
  const ids = locations.map((_, i) => `location_${i + 1}`);
  return {
    request: { temporalResolution: 'climatology', locations },
    metadata: { endpointUrls: ids.map((id) => `https://example.com/${id}`) },
    locations: ids.map((locationId) => ({
      locationId,
      metadata: { endpointUrl: `https://example.com/${locationId}` },
    })),
    failed: [],
    summaries: ids.map((locationId) => ({ locationId, year: null })),
    possibleSharedGridCell: [],
    rows: ids.flatMap((locationId) =>
      periods.map((periodKey) => ({ locationId, periodKey, latitude: 0, longitude: 0, T2M: 1 })),
    ) as unknown as ObservationRow[],
  } satisfies ComparisonShape;
}

describe('comparisonSplit', () => {
  it('splits sites into contiguous groups of at least two in input order', () => {
    const dataset = comparison(5);
    expect(comparisonSplit(dataset)(rowsAtMost(40))).toEqual({
      inlineRows: 39,
      calls: [
        { locations: dataset.request.locations.slice(0, 2) },
        { locations: dataset.request.locations.slice(2) },
      ],
    });
  });

  it('never offers a single-site group, so five sites whose pairs do not fit have no split', () => {
    expect(comparisonSplit(comparison(5))(rowsAtMost(30))).toEqual({ inlineRows: 30, calls: [] });
  });
});

describe('splitRecovery', () => {
  it('names the size, the capacity, the call count and every changed field', () => {
    expect(
      splitRecovery(366, {
        inlineRows: 140,
        calls: [
          { startDate: '2024-01-01', endDate: '2024-05-01' },
          { startDate: '2024-05-02', endDate: '2024-12-31', selection: {} },
        ],
      }),
    ).toBe(
      'The complete result has 366 rows and at most 140 fit inline in one call. Re-send it as the 2 calls listed in calls, each changing only startDate, endDate and selection and each fitting inline, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb to stage it whole.',
    );
  });

  it('says not even one row fits, and names the levers, when the inline capacity is zero', () => {
    expect(splitRecovery(130, { inlineRows: 0, calls: [] })).toBe(
      'The complete result has 130 rows, and not even one row of this request fits inline with its metadata. Request fewer parameters per call, or fewer sites per call for a comparison, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb to stage it whole.',
    );
  });

  it('says no split fits when there are no calls', () => {
    expect(splitRecovery(260, { inlineRows: 200, calls: [] })).toBe(
      'The complete result has 260 rows and at most 200 fit inline in one call. No split of this request fits inline; request fewer parameters or a smaller window, region or site list, or use the npm or Docker distribution with CANVAS_PROVIDER_TYPE=duckdb to stage it whole.',
    );
  });
});
