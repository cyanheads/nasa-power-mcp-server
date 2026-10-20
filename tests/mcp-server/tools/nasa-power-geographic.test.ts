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
function feature(series: Record<string, Record<string, number>>, latitude = 40) {
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
    if (parsed.pathname.endsWith('/parameters')) return Response.json({ T2M: {}, RH2M: {} });
    if (parsed.pathname.endsWith('/configuration'))
      return Response.json({ settings: { start: '1981-01-01', end: '2025-12-31' } });
    return reply(parsed);
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    reply = () => Response.json(point());
    fetcher.mockClear();
    source = initPowerService({ fetch: fetcher, config: { dataframeDropEnabled: false } });
    canvas = initCanvasService({
      storage: createInMemoryStorage(),
      config: { dataframeDropEnabled: false },
    });
  });
  afterEach(async () => {
    source.dispose();
    await canvas.shutdown();
    vi.useRealTimers();
  });
  const observations = () =>
    fetcher.mock.calls.filter(([url]) => /\/(point|regional)\?/.test(String(url)));

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
    expect(text(result)).toContain('bad\nsource 422');
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
      config: { dataframeDropEnabled: false },
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
});
