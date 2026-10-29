/** @fileoverview Geographic contracts through the real HTTP and presentation seams. @module tests/mcp-server/tools/nasa-power-geographic */
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareLocationsTool } from '@/mcp-server/tools/definitions/nasa-power-compare-locations.tool.js';
import { getRegionTool } from '@/mcp-server/tools/definitions/nasa-power-get-region.tool.js';
import { initCanvasService } from '@/services/canvas/index.js';
import { initPowerService } from '@/services/power/index.js';
import { fakePower } from '../../fake-power.js';
import { markdownText } from '../../markdown-text.js';
import { sizedRefusal } from '../../sized-refusal.js';

const selection = { mode: 'parameters' as const, parameters: ['T2M'] };
const label = 'site\n**literal** | ``` https://example.com/site';
const locations = Array.from({ length: 3 }, (_, i) => ({
  latitude: 40 + i,
  longitude: -120,
  label,
}));
const region = {
  latitudeMin: 40,
  latitudeMax: 42,
  longitudeMin: -122,
  longitudeMax: -120,
  parameter: 'T2M',
  startDate: '2024-01-01',
  endDate: '2024-01-02',
};
function feature(series: Record<string, Record<string, number | string>>, latitude = 40) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-120, latitude, 10] },
    properties: { parameter: series },
  };
}
function point(
  series: Record<string, number> = { JAN: 1, FEB: 3, DEC: 5, ANN: 20 },
  units: string | undefined = 'C',
) {
  return {
    ...feature({ T2M: series }),
    header: { fill_value: -999, sources: ['https://example.com/source'] },
    parameters: { T2M: units === undefined ? {} : { units } },
  };
}
type WireResult = Awaited<ReturnType<typeof runToolContract>>;
const text = (result: WireResult) =>
  result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
const runRaw = <T extends Parameters<typeof runToolContract>[0]>(tool: T, args: unknown) =>
  runToolContract(tool, args as Parameters<typeof runToolContract<T>>[1]);
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(30_000);
  return promise;
}
function failure(result: WireResult, reason: string) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason, recovery: { hint: expect.any(String) } } },
  });
  const error = result.structuredContent as { error: { data: { recovery: { hint: string } } } };
  expect(text(result)).toContain(reason);
  expect(text(result)).toContain(error.error.data.recovery.hint);
}

describe('geographic HTTP contracts', () => {
  let source: ReturnType<typeof initPowerService>;
  let canvas: ReturnType<typeof initCanvasService>;
  let reply: (url: URL) => Response;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const parsed = new URL(String(url));
    /** POWER lists GDD10 and the hour-extreme group at every non-hourly resolution. */
    if (parsed.pathname.endsWith('/parameters'))
      return Response.json(
        Object.fromEntries(
          [
            'T2M',
            'RH2M',
            'T_ZONES',
            'TM_ZONES',
            'GDD10',
            'ALLSKY_SFC_SW_DWN_HR_MAX',
            'SI_TRACKER_AVG',
          ].map((code) => [code, {}]),
        ),
      );
    if (parsed.pathname.endsWith('/configuration'))
      return Response.json({ settings: { start: '1981-01-01', end: '2025-12-31' } });
    return reply(parsed);
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    reply = () => Response.json(point());
    fetcher.mockClear();
    source = initPowerService({
      fetch: fetcher,
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
    canvas = initCanvasService({
      storage: createInMemoryStorage(),
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
  });
  afterEach(async () => {
    source.dispose();
    await canvas.shutdown();
    vi.useRealTimers();
  });
  const observations = () =>
    fetcher.mock.calls.filter(([url]) => /\/(point|regional)\?/.test(String(url)));

  it.each(['T_ZONES', 'TM_ZONES'])(
    'excludes %s from comparison arithmetic and rejects explicit numeric sorting',
    async (code) => {
      reply = () =>
        Response.json({
          ...feature({ [code]: { JAN: 22, FEB: 61, ANN: 34 } }),
          parameters: { [code]: { units: 'zones' } },
        });
      const args = {
        locations,
        selection: { mode: 'parameters', parameters: [code] },
        community: 'SB',
      };
      const result = await settle(runRaw(compareLocationsTool, args));
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        parameters: [{ code, units: 'zones', valueKind: 'categorical' }],
        summaries: [],
        locations: [
          { summaries: [], sortMetric: null },
          { summaries: [], sortMetric: null },
          { summaries: [], sortMetric: null },
        ],
      });
      expect(text(result)).toContain('categorical');
      expect(markdownText(text(result)).match(/\bzones\b/g)).toHaveLength(4);
      failure(
        await settle(
          runRaw(compareLocationsTool, { ...args, sort: { parameter: code, direction: 'asc' } }),
        ),
        'unsupported_parameter',
      );
    },
  );

  it.each(['mismatch', 'missing'])(
    'keeps categorical units per location when shared units are %s',
    async (mode) => {
      reply = (url) =>
        Response.json({
          ...feature({ TM_ZONES: { ANN: 34 } }),
          parameters: {
            TM_ZONES:
              url.searchParams.get('latitude') === '40'
                ? { units: 'zones' }
                : mode === 'mismatch'
                  ? { units: 'classes' }
                  : {},
          },
        });
      const result = await settle(
        runRaw(compareLocationsTool, {
          locations,
          selection: { mode: 'parameters', parameters: ['TM_ZONES'] },
          community: 'SB',
        }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).not.toHaveProperty('parameters.0.units');
      expect(result.structuredContent).toHaveProperty('locations.0.parameters.0.units', 'zones');
      expect(markdownText(text(result)).match(/\bzones\b/g)).toHaveLength(1);
      if (mode === 'mismatch') {
        expect(result.structuredContent).toHaveProperty(
          'locations.1.parameters.0.units',
          'classes',
        );
        expect(markdownText(text(result)).match(/\bclasses\b/g)).toHaveLength(2);
      } else {
        expect(result.structuredContent).not.toHaveProperty('locations.1.parameters.0.units');
      }
    },
  );

  it('preserves shared orientation units independently of numeric comparability', async () => {
    reply = () =>
      Response.json({
        ...feature({
          SI_TILTED_AVG_OPTIMAL_ANG: { ANN: 20 },
          SI_TILTED_AVG_OPTIMAL_ANG_ORT: { ANN: 'S' },
        }),
        parameters: {
          SI_TILTED_AVG_OPTIMAL_ANG: { units: 'degrees' },
          SI_TILTED_AVG_OPTIMAL_ANG_ORT: { units: 'N/S Orientation' },
        },
      });
    const result = await settle(
      runRaw(compareLocationsTool, {
        locations,
        selection: { mode: 'parameters', parameters: ['SI_EF_TILTED_SURFACE'] },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      comparable: true,
      parameters: [
        { code: 'SI_TILTED_AVG_OPTIMAL_ANG', units: 'degrees', valueKind: 'number' },
        {
          code: 'SI_TILTED_AVG_OPTIMAL_ANG_ORT',
          units: 'N/S Orientation',
          valueKind: 'orientation',
        },
      ],
    });
    expect(markdownText(text(result)).match(/N\/S Orientation/g)).toHaveLength(4);
  });

  it.each([
    ['monthly', { startYear: 2023, endYear: 2023 }],
    ['climatology', {}],
  ] as const)(
    'rejects a %s GDD10 region on both surfaces before any request',
    async (temporalResolution, window) => {
      const { startDate: _start, endDate: _end, parameter: _parameter, ...bounds } = region;
      const result = await settle(
        runRaw(getRegionTool, { ...bounds, temporalResolution, ...window, parameter: 'GDD10' }),
      );
      failure(result, 'unsupported_parameter');
      expect(result.structuredContent).toMatchObject({
        error: {
          data: { parameters: ['GDD10'], recovery: { hint: expect.stringContaining('daily') } },
        },
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('rejects a GDD10 climatology comparison on both surfaces before any request', async () => {
    const result = await settle(
      runRaw(compareLocationsTool, {
        locations,
        selection: { mode: 'parameters', parameters: ['T2M', 'GDD10'] },
      }),
    );
    failure(result, 'unsupported_parameter');
    expect(result.structuredContent).toMatchObject({ error: { data: { parameters: ['GDD10'] } } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports a returned regional hour-extreme group under expansions on both surfaces', async () => {
    const members = ['ALLSKY_SFC_SW_DWN_00_MAX', 'ALLSKY_SFC_SW_DWN_12_MAX'];
    reply = () =>
      Response.json({
        type: 'FeatureCollection',
        features: [40, 41].map((latitude) =>
          feature(
            Object.fromEntries(members.map((code) => [code, { JAN: latitude, ANN: 2 }])),
            latitude,
          ),
        ),
        parameters: Object.fromEntries(members.map((code) => [code, { units: 'MJ/m^2/day' }])),
      });
    const { startDate: _start, endDate: _end, parameter: _parameter, ...bounds } = region;
    const result = await settle(
      runRaw(getRegionTool, {
        ...bounds,
        temporalResolution: 'climatology',
        parameter: 'ALLSKY_SFC_SW_DWN_HR_MAX',
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      expansions: { ALLSKY_SFC_SW_DWN_HR_MAX: members },
      omittedParameters: [],
    });
    expect(text(result)).not.toContain('[` code `, ` messages `]');
    for (const code of members) expect(text(result)).toContain(code);
  });
  it('reports each location tracker group under expansions on both surfaces', async () => {
    const members = ['SI_TRACKER_AVG_DUAL', 'SI_TRACKER_AVG_VSAT'];
    reply = () =>
      Response.json({
        ...feature(Object.fromEntries(members.map((code) => [code, { JAN: 1, ANN: 2 }]))),
        parameters: Object.fromEntries(members.map((code) => [code, { units: 'kW-hr/m^2/day' }])),
      });
    const result = await settle(
      runRaw(compareLocationsTool, {
        locations,
        selection: { mode: 'parameters', parameters: ['SI_TRACKER_AVG'] },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      locations: locations.map(() => ({
        expansions: { SI_TRACKER_AVG: members },
        omittedParameters: [],
      })),
    });
    /** The omission record header renders only when a location reports an omitted code. */
    expect(text(result)).not.toContain('[` code `, ` messages `]');
    for (const code of members) expect(text(result)).toContain(code);
  });
  it('preserves the precomputed regional climatology period without a requested year window', async () => {
    reply = () =>
      Response.json({
        type: 'FeatureCollection',
        features: [feature({ T2M: { JAN: 2, ANN: 3 } })],
        header: { start: '20010101', end: '20251231' },
        messages: ['Precomputed climatology'],
      });
    const { startDate: _start, endDate: _end, ...bounds } = region;
    const result = await settle(
      runRaw(getRegionTool, { ...bounds, temporalResolution: 'climatology' }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      metadata: {
        reportedStart: '20010101',
        reportedEnd: '20251231',
        messages: ['Precomputed climatology'],
      },
    });
    expect(text(result)).toContain('20010101');
    expect(text(result)).toContain('20251231');
  });

  it.each([{ startYear: 1991 }, { endYear: 2020 }, { startYear: 1991, endYear: 2020 }])(
    'rejects unsupported regional climatology years before any upstream request: %j',
    async (years) => {
      reply = () => Response.json({ type: 'FeatureCollection', features: [] });
      const { startDate: _start, endDate: _end, ...bounds } = region;
      const result = await settle(
        runRaw(getRegionTool, { ...bounds, temporalResolution: 'climatology', ...years }),
      );
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('nasa_power_get_climatology');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('preserves normalized comparison and per-location request echoes after duplicate selection repair', async () => {
    const result = await settle(
      runRaw(compareLocationsTool, {
        locations,
        selection: { mode: 'parameters', parameters: ['t2m', 'T2M'] },
        community: 'AG',
        units: 'imperial',
        timeStandard: 'UTC',
        startYear: 2001,
        endYear: 2020,
        sort: { parameter: 'T2M', direction: 'desc' },
      }),
    );
    expect(result.isError).not.toBe(true);
    const request = {
      temporalResolution: 'climatology',
      selection,
      community: 'AG',
      units: 'imperial',
      timeStandard: 'UTC',
      startYear: 2001,
      endYear: 2020,
    };
    expect(result.structuredContent).toMatchObject({
      request: { ...request, locations, sort: { parameter: 'T2M', direction: 'desc' } },
      locations: locations.map(({ latitude, longitude }) => ({
        request: { ...request, latitude, longitude },
      })),
    });
    for (const value of [
      'startYear',
      '2001',
      'endYear',
      '2020',
      'imperial',
      'UTC',
      'request',
      'selection',
    ])
      expect(text(result)).toContain(value);
    for (const [url] of observations())
      expect(new URL(String(url)).searchParams.get('parameters')).toBe('T2M');
  });

  it('retains all native cells and per-period sparse statistics, including empty cells', async () => {
    reply = () =>
      Response.json({
        type: 'FeatureCollection',
        features: [
          feature({ T2M: { '20240101': 0, '20240102': 8 } }),
          feature({ T2M: { '20240101': 4, '20240102': -999 } }, 41),
          feature({}, 42),
        ],
        header: { fill_value: -999 },
        parameters: { T2M: { units: 'C' } },
      });
    const result = await settle(runRaw(getRegionTool, region));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      cellCount: 3,
      rowCount: 4,
      dataset: null,
      rows: [
        { cellId: 'cell_1', T2M: 0 },
        { cellId: 'cell_1', T2M: 8 },
        { cellId: 'cell_2', T2M: 4 },
        { cellId: 'cell_2', T2M: null },
      ],
      summaries: [
        { periodKey: '20240101', validCellCount: 2, missingCellCount: 1, min: 0, mean: 2, max: 4 },
        { periodKey: '20240102', validCellCount: 1, missingCellCount: 2, mean: 8 },
      ],
    });
    for (const value of ['cell_1', 'cell_2', 'missingCellCount', '20240102'])
      expect(text(result)).toContain(value);
  });
  it('returns an empty native grid without manufacturing observations', async () => {
    reply = () => Response.json({ type: 'FeatureCollection', features: [] });
    const result = await settle(runRaw(getRegionTool, region));
    expect(result.structuredContent).toMatchObject({
      cellCount: 0,
      rowCount: 0,
      rows: [],
      summaries: [],
      dataset: null,
    });
    expect(text(result)).toContain('cellCount');
  });
  it.each([1.99, 10.01, -2])(
    'rejects invalid regional span %s before any network request',
    async (span) => {
      failure(
        await settle(runRaw(getRegionTool, { ...region, latitudeMax: 40 + span })),
        'invalid_region',
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('rejects antimeridian wrapping and multiple parameter input', async () => {
    failure(
      await settle(runRaw(getRegionTool, { ...region, longitudeMin: 179, longitudeMax: -179 })),
      'invalid_region',
    );
    expect((await runRaw(getRegionTool, { ...region, parameter: ['T2M', 'RH2M'] })).isError).toBe(
      true,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([2, 10])('accepts inclusive regional span %s', async (span) => {
    reply = () => Response.json({ type: 'FeatureCollection', features: [] });
    expect(
      (
        await settle(
          runRaw(getRegionTool, { ...region, latitudeMax: 40 + span, longitudeMax: -122 + span }),
        )
      ).isError,
    ).not.toBe(true);
  });
  it('defaults to climatology and preserves duplicate multiline labels and input identities on both paths', async () => {
    const result = await settle(runRaw(compareLocationsTool, { locations, selection }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      request: { temporalResolution: 'climatology' },
      locations: locations.map((item, i) => ({ ...item, locationId: `location_${i + 1}` })),
      partial: false,
      comparable: true,
      possibleSharedGridCell: [['location_1', 'location_2', 'location_3']],
      summaries: expect.arrayContaining([
        expect.objectContaining({
          bucket: 'annual',
          method: 'source_annual',
          expectedPeriods: 1,
          complete: true,
          mean: 20,
        }),
        expect.objectContaining({ bucket: 'DJF', mean: 3, expectedPeriods: 3, complete: true }),
      ]),
    });
    expect(text(result)).toContain(label);
    expect(text(result)).toContain('[https://example.com/source](<https://example.com/source>)');
    expect(text(result)).toContain('location_3');
  });
  it.each([
    [
      'daily',
      { startDate: '2024-02-28', endDate: '2024-03-01' },
      { '20240228': 2, '20240229': 4, '20240301': 6 },
      366,
      3,
      'observation_mean',
    ],
    [
      'hourly',
      { startDate: '2024-02-29', endDate: '2024-02-29' },
      { '2024022900': 2, '2024022901': 4 },
      8784,
      2,
      'observation_mean',
    ],
    [
      'monthly',
      { startYear: 2024, endYear: 2024 },
      { '202401': 2, '202402': 4, '202413': 90 },
      1,
      1,
      'source_annual',
    ],
  ] as const)(
    'calculates %s annual and seasonal completeness without imputation',
    async (temporalResolution, window, series, expectedPeriods, includedPeriods, method) => {
      reply = () => Response.json(point(series));
      const result = await settle(
        runRaw(compareLocationsTool, {
          locations: locations.slice(0, 2),
          selection,
          temporalResolution,
          ...window,
        }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        summaries: expect.arrayContaining([
          expect.objectContaining({
            locationId: 'location_1',
            bucket: 'annual',
            year: 2024,
            expectedPeriods,
            includedPeriods,
            method,
            complete: temporalResolution === 'monthly',
            windowClipped: temporalResolution !== 'monthly',
          }),
          expect.objectContaining({
            locationId: 'location_1',
            bucket: 'DJF',
            expectedPeriods:
              temporalResolution === 'monthly' ? 3 : temporalResolution === 'hourly' ? 2184 : 91,
            windowClipped: true,
            complete: false,
          }),
        ]),
      });
      for (const key of ['expectedPeriods', 'includedPeriods', method, 'windowClipped'])
        expect(text(result)).toContain(key);
    },
  );
  it('sorts source annual metrics with stable ties and nulls last', async () => {
    const sites = [...locations, { latitude: 43, longitude: -120, label: 'four' }];
    reply = (url) =>
      Response.json(
        point({
          ANN:
            url.searchParams.get('latitude') === '40'
              ? -999
              : url.searchParams.get('latitude') === '43'
                ? 1
                : 2,
          JAN: 999,
        }),
      );
    const result = await settle(
      runRaw(compareLocationsTool, {
        locations: sites,
        selection,
        sort: { parameter: 'T2M', direction: 'asc' },
      }),
    );
    expect(result.structuredContent).toMatchObject({
      locations: [
        { locationId: 'location_4', sortMetric: 1 },
        { locationId: 'location_2', sortMetric: 2 },
        { locationId: 'location_3', sortMetric: 2 },
        { locationId: 'location_1', sortMetric: null },
      ],
      sort: { criterion: 'source_ANN', ties: 'input_order', nulls: 'last' },
    });
    expect(text(result)).toContain('source_ANN');
  });
  it('rejects unit-mismatched sorting while disclosing the unsorted metric mismatch', async () => {
    reply = (url) =>
      Response.json(point({ ANN: 1 }, url.searchParams.get('latitude') === '40' ? 'C' : 'F'));
    const result = await settle(runRaw(compareLocationsTool, { locations, selection }));
    expect(result.structuredContent).toMatchObject({
      comparable: false,
      parameters: [{ code: 'T2M' }],
      locations: locations.map(() => ({ sortMetric: null })),
    });
    failure(
      await settle(
        runRaw(compareLocationsTool, {
          locations,
          selection,
          sort: { parameter: 'T2M', direction: 'asc' },
        }),
      ),
      'unsupported_parameter',
    );
  });
  it.each([
    { selection: { mode: 'parameters', parameters: ['UNKNOWN'] } },
    { temporalResolution: 'daily', startDate: '2024-02-02', endDate: '2024-01-01' },
    { sort: { parameter: 'RH2M', direction: 'asc' } },
  ])('preflights shared bad input before observations: %j', async (extra) => {
    expect(
      (await settle(runRaw(compareLocationsTool, { locations, selection, ...extra }))).isError,
    ).toBe(true);
    expect(observations()).toHaveLength(0);
  });
  it('preserves successful sites and actionable rejected-site diagnostics on both paths', async () => {
    reply = (url) =>
      url.searchParams.get('latitude') === '41'
        ? Response.json({ messages: ['bad\nsource 422'] }, { status: 422 })
        : Response.json(point());
    const result = await settle(runRaw(compareLocationsTool, { locations, selection }));
    expect(result.structuredContent).toMatchObject({
      partial: true,
      locations: [{ locationId: 'location_1' }, { locationId: 'location_3' }],
      failed: [
        {
          locationId: 'location_2',
          reason: 'upstream_rejected',
          message: expect.stringContaining('bad\nsource 422'),
          recovery: expect.any(String),
        },
      ],
    });
    expect(text(result)).toContain('bad\nsource 422');
    expect(text(result)).toContain('upstream_rejected');
  });
  it('reports all failures and nested diagnostics on both surfaces', async () => {
    reply = () => Response.json({ messages: ['bad\nsource 422'] }, { status: 422 });
    const result = await settle(runRaw(compareLocationsTool, { locations, selection }));
    failure(result, 'all_locations_failed');
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          failed: locations.map((_, i) => ({
            locationId: `location_${i + 1}`,
            reason: 'upstream_rejected',
          })),
        },
      },
    });
    expect(markdownText(text(result))).toContain('bad\nsource 422');
    expect(text(result)).toContain('location_3');
  });
  it('stops unsent sites after a 429 while preserving earlier successes', async () => {
    reply = (url) =>
      url.searchParams.get('latitude') === '40'
        ? Response.json(point())
        : Response.json(
            { messages: ['slow down'] },
            { status: 429, headers: { 'retry-after': '60' } },
          );
    const result = await settle(runRaw(compareLocationsTool, { locations, selection }));
    expect(observations()).toHaveLength(2);
    expect(result.structuredContent).toMatchObject({
      partial: true,
      failed: [
        { locationId: 'location_2', reason: 'upstream_rate_limited' },
        { locationId: 'location_3', reason: 'upstream_rate_limited' },
      ],
    });
    expect(text(result)).toContain('slow down');
    expect(text(result)).toContain('location_3');
  });
  it('uses exactly two shared references and ten point attempts for a cold maximum comparison', async () => {
    const sites = Array.from({ length: 10 }, (_, i) => ({
      latitude: i,
      longitude: 0,
      label: `site ${i}`,
    }));
    const started = Date.now();
    const result = await settle(runRaw(compareLocationsTool, { locations: sites, selection }));
    expect(result.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(observations()).toHaveLength(10);
    expect(Date.now() - started).toBeLessThan(55_000);
  });
  it('keeps one shared deadline even when later locations still have individual attempt time', async () => {
    let elapsed = 0;
    source.dispose();
    source = initPowerService({
      fetch: fetcher,
      now: () => Date.now() + elapsed,
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
    reply = () => {
      elapsed += 30_000;
      return Response.json(point());
    };
    const result = await settle(runRaw(compareLocationsTool, { locations, selection }));
    expect(observations()).toHaveLength(2);
    expect(result.structuredContent).toMatchObject({
      partial: true,
      locations: [{ locationId: 'location_1' }],
      failed: [{ locationId: 'location_2' }, { locationId: 'location_3' }],
    });
    expect(text(result)).toContain('deadline');
  });
  it('counts retries against the shared twelve-attempt ceiling', async () => {
    let index = 0;
    reply = () => {
      index++;
      return index === 1
        ? Response.json({ messages: ['retry'] }, { status: 500 })
        : Response.json(point());
    };
    const sites = Array.from({ length: 10 }, (_, i) => ({
      latitude: i,
      longitude: 0,
      label: `site ${i}`,
    }));
    const result = await settle(runRaw(compareLocationsTool, { locations: sites, selection }));
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(result.structuredContent).toMatchObject({
      partial: true,
      locations: expect.any(Array),
      failed: [{ locationId: 'location_10', message: expect.stringContaining('attempt budget') }],
    });
    expect(text(result)).toContain('location_10');
  });
  it('enforces the cumulative decoded-body ceiling across independently valid site responses', async () => {
    const padding = 'x'.repeat(12 * 1024 * 1024);
    reply = () => Response.json({ ...point(), padding });
    const result = await settle(runRaw(compareLocationsTool, { locations, selection }));
    failure(result, 'dataset_limit');
    expect(observations()).toHaveLength(3);
  });
  it('propagates cancellation rather than turning it into a failed site', async () => {
    const controller = new AbortController();
    reply = () => {
      controller.abort();
      return Response.json(point());
    };
    const ctx = createMockContext({
      signal: controller.signal,
      errors: compareLocationsTool.errors,
    });
    const pending = Promise.resolve(
      compareLocationsTool.handler(
        compareLocationsTool.input.parse({
          temporalResolution: 'climatology',
          locations,
          selection,
        }),
        ctx,
      ),
    );
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await caught).toBeInstanceOf(Error);
    expect(observations()).toHaveLength(1);
  });
  it('assigns December to the following leap-year DJF bucket', async () => {
    reply = () => Response.json(point({ '20231231': 2, '20240101': 4, '20240229': 6 }));
    const result = await settle(
      runRaw(compareLocationsTool, {
        temporalResolution: 'daily',
        startDate: '2023-12-01',
        endDate: '2024-02-29',
        locations,
        selection,
      }),
    );
    expect(result.structuredContent).toMatchObject({
      summaries: expect.arrayContaining([
        expect.objectContaining({
          locationId: 'location_1',
          bucket: 'DJF',
          year: 2024,
          mean: 4,
          expectedPeriods: 91,
          includedPeriods: 3,
          returnedPeriods: 3,
          windowClipped: false,
          complete: false,
        }),
      ]),
    });
    expect(text(result)).toContain('DJF');
  });
  it('evaluates comparability independently per metric when sorting', async () => {
    reply = (url) =>
      Response.json({
        ...point({ ANN: 5 }),
        properties: { parameter: { T2M: { ANN: 5 }, RH2M: { ANN: 2 } } },
        parameters: {
          T2M: { units: 'C' },
          RH2M: { units: url.searchParams.get('latitude') === '40' ? '%' : 'ratio' },
        },
      });
    const result = await settle(
      runRaw(compareLocationsTool, {
        locations,
        selection: { mode: 'parameters', parameters: ['T2M', 'RH2M'] },
        sort: { parameter: 'T2M', direction: 'desc' },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      comparable: false,
      sort: { parameter: 'T2M' },
      locations: locations.map(() => ({ sortMetric: 5 })),
    });
    expect(text(result)).toContain('ratio');
  });
  it('refuses merged normalized rows that exceed the combined byte budget', async () => {
    const start = Date.UTC(2001, 0, 1);
    const series = Object.fromEntries(
      Array.from({ length: 90_000 }, (_, i) => [
        new Date(start + i * 3_600_000)
          .toISOString()
          .slice(0, 13)
          .replaceAll('-', '')
          .replace('T', ''),
        i + 0.125,
      ]),
    );
    reply = () => Response.json(point(series));
    const result = await settle(
      runRaw(compareLocationsTool, {
        temporalResolution: 'hourly',
        startDate: '2001-01-01',
        endDate: '2020-01-01',
        locations: locations.slice(0, 2),
        selection,
      }),
    );
    failure(result, 'dataset_limit');
    expect(observations()).toHaveLength(2);
  }, 15_000);

  describe('sized canvas_required splits re-sent through the tool', () => {
    /** Answers any window, box and code list, like POWER; inline-only canvas from the outer setup. */
    const offline = (codes: string[]) => {
      const fake = fakePower(codes);
      source.dispose();
      source = initPowerService({
        fetch: fake.fetch,
        config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
      });
    };
    type Row = { periodKey: string; latitude: number; longitude: number; label?: string };
    /** Cell and location ids are positional within one call, so identity is coordinates and label. */
    const identity = (row: Row) =>
      `${row.label ?? ''}|${row.latitude}|${row.longitude}|${row.periodKey}`;
    const resend = async (
      tool: typeof getRegionTool | typeof compareLocationsTool,
      args: Record<string, unknown>,
      calls: Record<string, unknown>[],
    ) => {
      const rows: Row[] = [];
      for (const call of calls) {
        const result = await settle(runRaw(tool, { ...args, ...call }));
        expect(result.isError).not.toBe(true);
        const output = result.structuredContent as { rowCount: number; dataset: null; rows: Row[] };
        expect(output).toMatchObject({ dataset: null, rowCount: output.rows.length });
        rows.push(...output.rows);
      }
      return rows;
    };

    it('splits a daily region by contiguous date windows that sum to the row count', async () => {
      offline(['T2M']);
      const args = { ...region, startDate: '2024-01-01', endDate: '2024-01-31' };
      /** 5 latitudes × 4 longitudes on the 0.5° × 0.625° grid, 31 days. */
      const split = sizedRefusal(await settle(runRaw(getRegionTool, args)), 620);
      for (const call of split.calls)
        expect(Object.keys(call).sort()).toEqual(['endDate', 'startDate']);
      expect(split.calls[0]).toMatchObject({ startDate: '2024-01-01' });
      expect(split.calls.at(-1)).toMatchObject({ endDate: '2024-01-31' });
      const rows = await resend(getRegionTool, args, split.calls);
      expect(rows).toHaveLength(620);
      expect(new Set(rows.map(identity)).size).toBe(620);
    });

    it('splits a region whose single day exceeds one call into day windows over tiles of at least 2° per axis', async () => {
      offline(['T2M']);
      const args = {
        latitudeMin: 40,
        latitudeMax: 50,
        longitudeMin: -125,
        longitudeMax: -115,
        parameter: 'T2M',
        startDate: '2024-01-01',
        endDate: '2024-01-03',
      };
      /** 21 latitudes × 17 longitudes, 3 days. */
      const split = sizedRefusal(await settle(runRaw(getRegionTool, args)), 1071);
      for (const call of split.calls) {
        const tile = call as Record<
          'latitudeMin' | 'latitudeMax' | 'longitudeMin' | 'longitudeMax',
          number
        >;
        expect(Object.keys(tile).sort()).toEqual([
          'endDate',
          'latitudeMax',
          'latitudeMin',
          'longitudeMax',
          'longitudeMin',
          'startDate',
        ]);
        expect(tile.latitudeMax - tile.latitudeMin).toBeGreaterThanOrEqual(2);
        expect(tile.longitudeMax - tile.longitudeMin).toBeGreaterThanOrEqual(2);
      }
      const tiles = new Set(split.calls.map((call) => `${call.latitudeMin}|${call.longitudeMin}`));
      expect(tiles.size).toBeGreaterThan(1);
      const rows = await resend(getRegionTool, args, split.calls);
      /** POWER's bounds are inclusive, so tiles must partition the grid: each cell-day exactly once. */
      expect(rows).toHaveLength(1071);
      expect(new Set(rows.map(identity)).size).toBe(1071);
    });

    it('partitions an off-grid region into tiles that return each cell-day exactly once', async () => {
      offline(['T2M']);
      const args = {
        latitudeMin: 40.2,
        latitudeMax: 50.2,
        longitudeMin: -124.9,
        longitudeMax: -114.9,
        parameter: 'T2M',
        startDate: '2024-01-01',
        endDate: '2024-01-03',
      };
      /** 20 latitudes (40.5 to 50) × 16 longitudes (−124.375 to −115), 3 days. */
      const split = sizedRefusal(await settle(runRaw(getRegionTool, args)), 960);
      const tiles = new Set(split.calls.map((call) => `${call.latitudeMin}|${call.longitudeMin}`));
      expect(tiles.size).toBeGreaterThan(1);
      for (const call of split.calls) {
        const tile = call as Record<
          'latitudeMin' | 'latitudeMax' | 'longitudeMin' | 'longitudeMax',
          number
        >;
        expect(tile.latitudeMax - tile.latitudeMin).toBeGreaterThanOrEqual(2);
        expect(tile.longitudeMax - tile.longitudeMin).toBeGreaterThanOrEqual(2);
      }
      const rows = await resend(getRegionTool, args, split.calls);
      expect(rows).toHaveLength(960);
      expect(new Set(rows.map(identity)).size).toBe(960);
    });

    it('splits a 1° solar-grid climatology region at the midpoint between cell centers', async () => {
      offline(['ALLSKY_SFC_SW_DWN']);
      const args = {
        latitudeMin: 40,
        latitudeMax: 44.9,
        longitudeMin: -122,
        longitudeMax: -118,
        parameter: 'ALLSKY_SFC_SW_DWN',
        temporalResolution: 'climatology',
      };
      /** 5 latitudes (40.5 to 44.5) × 4 longitudes (−121.5 to −118.5) × 13 periods. */
      const split = sizedRefusal(await settle(runRaw(getRegionTool, args)), 260);
      expect(split.calls).toEqual([
        { latitudeMin: 40, latitudeMax: 44.9, longitudeMin: -122, longitudeMax: -120 },
        { latitudeMin: 40, latitudeMax: 44.9, longitudeMin: -120, longitudeMax: -118 },
      ]);
      const rows = await resend(getRegionTool, args, split.calls);
      const periods = [
        ...['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
        'ANN',
      ];
      const expected = [40.5, 41.5, 42.5, 43.5, 44.5].flatMap((latitude) =>
        [-121.5, -120.5, -119.5, -118.5].flatMap((longitude) =>
          periods.map((periodKey) => identity({ latitude, longitude, periodKey })),
        ),
      );
      expect(rows.map(identity).sort()).toEqual(expected.sort());
    });

    it('splits a daily-year comparison by contiguous date windows that sum to the row count', async () => {
      offline(['T2M']);
      const args = {
        temporalResolution: 'daily',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        locations,
        selection,
      };
      const split = sizedRefusal(await settle(runRaw(compareLocationsTool, args)), 3 * 366);
      for (const call of split.calls)
        expect(Object.keys(call).sort()).toEqual(['endDate', 'startDate']);
      expect(split.calls[0]).toMatchObject({ startDate: '2024-01-01' });
      expect(split.calls.at(-1)).toMatchObject({ endDate: '2024-12-31' });
      const rows = await resend(compareLocationsTool, args, split.calls);
      expect(rows).toHaveLength(3 * 366);
      expect(new Set(rows.map(identity)).size).toBe(3 * 366);
    });

    it('splits a wide ten-site climatology comparison into site groups of at least two', async () => {
      const codes = Array.from({ length: 6 }, (_, i) => `P${i}`);
      offline(codes);
      /** One label carries Markdown and JSON syntax and a line break, so each call line must round-trip it. */
      const sites = Array.from({ length: 10 }, (_, i) => ({
        latitude: 30 + i,
        longitude: -100 - i,
        label: i === 0 ? 'site `0` | *a* [b] "c" \\ {d}\ne' : `site ${i}`,
      }));
      const args = { locations: sites, selection: { mode: 'parameters', parameters: codes } };
      const split = sizedRefusal(await settle(runRaw(compareLocationsTool, args)), 130);
      const groups = split.calls.map((call) => (call as { locations: typeof sites }).locations);
      for (const [index, group] of groups.entries()) {
        expect(Object.keys(split.calls[index] ?? {})).toEqual(['locations']);
        expect(group.length).toBeGreaterThanOrEqual(2);
      }
      expect(groups.flat()).toEqual(sites);
      const rows = await resend(compareLocationsTool, args, split.calls);
      expect(rows).toHaveLength(130);
      expect(new Set(rows.map(identity)).size).toBe(130);
    });
  });
});
