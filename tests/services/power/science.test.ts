/** @fileoverview Scientific normalization and request contract behavior. @module tests/services/power/science */
import { describe, expect, it } from 'vitest';
import {
  assertDatasetBounds,
  normalizePoint,
  normalizeRegion,
  PointPayloadSchema,
  parsePeriod,
  RegionPayloadSchema,
} from '@/services/power/normalize.js';
import { compareDatasets, summarizeBuckets } from '@/services/power/summarize.js';
import {
  CompareRequestSchema,
  ParameterDictionarySchema,
  PowerConfigurationSchema,
  PowerDatasetSchema,
  PowerRequestSchema,
  RegionRequestSchema,
} from '@/services/power/types.js';

const access = {
  endpointUrl: 'https://power.larc.nasa.gov/example',
  fetchedAt: '2026-10-19T00:00:00Z',
  cacheHit: false,
};
const request = (extra = {}) =>
  PowerRequestSchema.parse(
    Object.fromEntries(
      Object.entries({
        temporalResolution: 'daily',
        latitude: 47,
        longitude: -122,
        startDate: '1982-01-01',
        endDate: '1982-01-03',
        selection: { mode: 'parameters', parameters: ['T2M', 'ALLSKY_SFC_SW_DWN'] },
        ...extra,
      }).filter(([, value]) => value !== undefined),
    ),
  );
const payload = (parameter: Record<string, Record<string, number | string>>) =>
  PointPayloadSchema.parse({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-122, 47] },
    properties: { parameter },
    header: { fill_value: -999 },
    parameters: { T2M: { units: 'C', custom: { nested: [null, 1] } } },
  });

describe('scientific contracts', () => {
  it('defaults point and region to daily and comparison to climatology', () => {
    expect(request({ temporalResolution: undefined }).temporalResolution).toBe('daily');
    expect(
      RegionRequestSchema.parse({
        latitudeMin: 0,
        latitudeMax: 2,
        longitudeMin: 0,
        longitudeMax: 2,
        parameter: 'T2M',
        startDate: '2024-01-01',
        endDate: '2024-01-01',
      }).temporalResolution,
    ).toBe('daily');
    expect(
      CompareRequestSchema.parse({
        locations: [
          { label: 'one', latitude: 0, longitude: 0 },
          { label: 'two', latitude: 1, longitude: 1 },
        ],
      }).temporalResolution,
    ).toBe('climatology');
  });
  it('requires canonical enum spellings and normalizes parameter codes', () => {
    expect(
      request({
        temporalResolution: 'daily',
        community: 'RE',
        timeStandard: 'UTC',
        units: 'metric',
        selection: { mode: 'parameters', parameters: [' t2m '] },
      }),
    ).toMatchObject({
      temporalResolution: 'daily',
      community: 'RE',
      timeStandard: 'UTC',
      units: 'metric',
      selection: { mode: 'parameters', parameters: ['T2M'] },
    });
    for (const extra of [
      { temporalResolution: 'DAILY' },
      { community: 're' },
      { timeStandard: 'utc' },
      { units: 'METRIC' },
    ])
      expect(() => request(extra)).toThrow();
  });
  it('retains sparse dictionary null inputs and configurations without formats', () => {
    expect(ParameterDictionarySchema.parse({ T2M: { inputs: null }, RH2M: {} })).toEqual({
      T2M: { inputs: null },
      RH2M: {},
    });
    expect(PowerConfigurationSchema.parse({ settings: { start: '1981-01-01' } })).toEqual({
      settings: { start: '1981-01-01' },
    });
  });
  it('rejects impossible dates, mixed windows, infinite coordinates and region corrections', () => {
    for (const extra of [{ startDate: '2024-02-30' }, { startYear: 2024 }, { latitude: Infinity }])
      expect(() => request(extra)).toThrow();
    expect(() =>
      RegionRequestSchema.parse({
        temporalResolution: 'daily',
        latitudeMin: 0,
        latitudeMax: 2,
        longitudeMin: 0,
        longitudeMax: 2,
        parameter: 'T2M',
        startDate: '2024-01-01',
        endDate: '2024-01-01',
        siteElevation: 0,
      }),
    ).toThrow();
  });
  it('preserves zero, fill and absent-key counts while disclosing omitted solar', () => {
    const data = normalizePoint(
      payload({ T2M: { '19820101': 0, '19820102': -999 }, RH2M: { '19820103': 3 } }),
      request(),
      access,
    );
    expect(PowerDatasetSchema.safeParse(data).success).toBe(true);
    expect(data.rows.map((row) => row.T2M)).toEqual([0, null, null]);
    expect(data.summaries.find((summary) => summary.parameter === 'T2M')).toMatchObject({
      validCount: 1,
      missingCount: 2,
      fillCount: 1,
      absentKeyCount: 1,
      mean: 0,
      min: 0,
      max: 0,
      lastValidDate: '1982-01-01',
    });
    expect(data.omittedParameters).toEqual([{ code: 'ALLSKY_SFC_SW_DWN', messages: [] }]);
    expect(data.parameters.find((parameter) => parameter.code === 'RH2M')).not.toHaveProperty(
      'units',
    );
    expect(data.metadata.returnedCoordinates?.elevation).toBeNull();
  });
  it('keeps all-fill series unknown without inventing calendar rows', () => {
    const data = normalizePoint(payload({ T2M: { '19820102': -999 } }), request(), access);
    expect(data.rows).toHaveLength(1);
    expect(data.summaries[0]).toMatchObject({
      validCount: 0,
      missingCount: 1,
      lastValidDate: null,
      mean: null,
      min: null,
      max: null,
    });
  });
  it('refuses excess scientific columns and rows without truncation', () => {
    const columns = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`P${index}`, { '19820101': 1 }]),
    );
    expect(() => normalizePoint(payload(columns), request(), access)).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'dataset_limit' }) }),
    );
    const row = normalizePoint(payload({ T2M: { '19820101': 1 } }), request(), access).rows[0]!;
    expect(() => assertDatasetBounds(Array(250001).fill(row))).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'dataset_limit' }) }),
    );
  });
  it('expands dynamic tilted members and excludes orientation from numeric summaries', () => {
    const data = normalizePoint(
      payload({ SI_TILTED_NEW: { JAN: 0, ANN: 2 }, SI_TILTED_NEW_ORT: { JAN: 'S', ANN: 'N' } }),
      request({
        temporalResolution: 'climatology',
        startDate: undefined,
        endDate: undefined,
        selection: { mode: 'parameters', parameters: ['SI_EF_TILTED_SURFACE'] },
      }),
      access,
    );
    expect(data.expansions).toEqual({
      SI_EF_TILTED_SURFACE: ['SI_TILTED_NEW', 'SI_TILTED_NEW_ORT'],
    });
    expect(data.omittedParameters).toEqual([]);
    expect(data.rows[0]?.SI_TILTED_NEW_ORT).toBe('S');
    expect(data.summaries.every((summary) => summary.parameter === 'SI_TILTED_NEW')).toBe(true);
  });
  it('distinguishes annual keys and UTC from LST without manufacturing dates', () => {
    expect(parsePeriod('202413', 'monthly')).toMatchObject({
      periodKind: 'annual',
      month: null,
      date: null,
    });
    expect(parsePeriod('ANN', 'climatology')).toMatchObject({
      periodKind: 'climatology_annual',
      year: null,
    });
    expect(parsePeriod('2024022903', 'hourly', 'UTC').date).toBe('2024-02-29T03:00:00Z');
    expect(parsePeriod('2024022903', 'hourly', 'LST').date).toBe('2024-02-29T03:00:00');
    for (const key of ['2024023000', '2024022924'])
      expect(() => parsePeriod(key, 'hourly')).toThrow();
  });
  it('counts missing cells even when a cell has no returned period', () => {
    const one = payload({ T2M: { '19820101': 0 } });
    const empty = payload({ T2M: {} });
    const data = normalizeRegion(
      RegionPayloadSchema.parse({ type: 'FeatureCollection', features: [one, empty] }),
      RegionRequestSchema.parse({
        temporalResolution: 'daily',
        latitudeMin: 0,
        latitudeMax: 2,
        longitudeMin: 0,
        longitudeMax: 2,
        parameter: 'T2M',
        startDate: '1982-01-01',
        endDate: '1982-01-01',
      }),
      access,
    );
    expect(data.cellCount).toBe(2);
    expect(data.summaries[0]).toMatchObject({ validCellCount: 1, missingCellCount: 1, mean: 0 });
  });
  it('uses leap-year expectations and clipped DJF windows', () => {
    const data = normalizePoint(
      payload({ T2M: { '20240229': 10 } }),
      request({ startDate: '2024-01-01', endDate: '2024-12-31' }),
      access,
    );
    const summaries = summarizeBuckets(data, 'location_1');
    expect(summaries.find((summary) => summary.bucket === 'annual')).toMatchObject({
      expectedPeriods: 366,
      includedPeriods: 1,
      complete: false,
      windowClipped: false,
    });
    expect(
      summaries.find((summary) => summary.bucket === 'DJF' && summary.year === 2024),
    ).toMatchObject({ expectedPeriods: 91, windowClipped: true });
  });
  it('keeps source annual distinct from monthly means and blocks unknown-unit sorting', () => {
    const data = normalizePoint(
      payload({ T2M: { '202401': 1, '202402': 2, '202403': 3, '202413': 100 } }),
      request({
        temporalResolution: 'monthly',
        startDate: undefined,
        endDate: undefined,
        startYear: 2024,
        endYear: 2024,
      }),
      access,
    );
    expect(data.summaries.find((summary) => summary.periodKind === 'month')?.mean).toBe(2);
    expect(
      summarizeBuckets(data, 'one').find((summary) => summary.bucket === 'annual'),
    ).toMatchObject({ mean: 100, method: 'source_annual', complete: true });
    expect(compareDatasets([{ locationId: 'one', dataset: data }]).sortMetrics[0]?.mean).toBe(100);
    data.parameters[0] = { code: 'T2M', valueKind: 'number', extra: {} };
    expect(compareDatasets([{ locationId: 'one', dataset: data }])).toMatchObject({
      comparable: false,
      sortMetrics: [{ mean: null }],
    });
  });
});
