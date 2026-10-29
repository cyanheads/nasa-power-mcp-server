/** @fileoverview Point and discovery contracts through the real network and presentation seams. @module tests/mcp-server/tools/nasa-power-point-discovery */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POWER_LIMITS } from '@/config/server-config.js';
import { compareLocationsTool } from '@/mcp-server/tools/definitions/nasa-power-compare-locations.tool.js';
import { getClimatologyTool } from '@/mcp-server/tools/definitions/nasa-power-get-climatology.tool.js';
import { getTimeseriesTool } from '@/mcp-server/tools/definitions/nasa-power-get-timeseries.tool.js';
import { listReferenceTool } from '@/mcp-server/tools/definitions/nasa-power-list-reference.tool.js';
import { searchParametersTool } from '@/mcp-server/tools/definitions/nasa-power-search-parameters.tool.js';
import { initCanvasService } from '@/services/canvas/index.js';
import { initPowerService } from '@/services/power/index.js';
import { PRESETS } from '@/services/power/presets.js';
import { fakePower, streamedBody } from '../../fake-power.js';
import { markdownText } from '../../markdown-text.js';
import { sizedRefusal } from '../../sized-refusal.js';

const input = {
  temporalResolution: 'daily' as const,
  latitude: 47,
  longitude: -122,
  startDate: '2024-01-01',
  endDate: '2024-01-02',
  selection: { mode: 'parameters' as const, parameters: ['T2M'] },
};
const message = 'source\n**literal** | ``` \\ value https://example.com/source';
const dictionary = Object.fromEntries(
  [...new Set([...Object.values(PRESETS).flat(), 'PSC', 'WSC', 'RH2M'])].map((code) => [code, {}]),
);
const payload = (series: Record<string, Record<string, number | string>>) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-122, 47] },
  properties: { parameter: series },
  header: { fill_value: -999, time_standard: 'LST', sources: ['https://example.com/source'] },
  parameters: { T2M: { units: 'C', longname: message, nested: { retained: [null, 0, message] } } },
  messages: [message],
});
let source: ReturnType<typeof initPowerService>;
let canvas: ReturnType<typeof initCanvasService>;
let body = payload({ T2M: { '20240101': 0, '20240102': -999 } });
let entries: Record<string, object> = dictionary;
let status = 200;
const fetcher = vi.fn<typeof fetch>(async (url) => {
  if (String(url).includes('/parameters?')) return Response.json(entries);
  if (String(url).endsWith('/configuration'))
    return Response.json({ settings: { start: '1981-01-01', end: '2025-12-31' } });
  return Response.json(status === 200 ? body : { messages: [message] }, { status });
});
const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
/** Deliberately admit malformed wire arguments to exercise the public parser. */
const runRaw = <T extends Parameters<typeof runToolContract>[0]>(definition: T, args: unknown) =>
  runToolContract(definition, args as Parameters<typeof runToolContract<T>>[1]);
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(6000);
  return promise;
}
function failure(result: Awaited<ReturnType<typeof runToolContract>>, reason: string) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { data: { reason, recovery: { hint: expect.any(String) } } },
  });
  const { error } = result.structuredContent as { error: { data: { recovery: { hint: string } } } };
  expect(markdownText(text(result))).toContain(error.data.recovery.hint);
  expect(text(result)).toContain(reason);
}

describe('point tool consumption contracts', () => {
  it('explains point-only custom climatology years and categorical exclusions on both surfaces', async () => {
    const coverage = await runToolContract(listReferenceTool, { topic: 'coverage' });
    const coverageGuidance = (coverage.structuredContent as { guidance: string[] }).guidance.join(
      ' ',
    );
    expect(coverageGuidance).toContain('Regional climatology accepts no year fields');
    expect(markdownText(text(coverage))).toContain('Regional climatology accepts no year fields');
    const missing = await runToolContract(listReferenceTool, { topic: 'missing_data' });
    expect((missing.structuredContent as { guidance: string[] }).guidance.join(' ')).toContain(
      'categorical',
    );
    expect(markdownText(text(missing))).toContain('TM_ZONES');
  });
  it.each(['SI_TILTED_AVG', 'SI_TILTED_MIN', 'SI_TILTED_MAX'])(
    'reports returned %s aliases and source messages on both surfaces',
    async (alias) => {
      entries = { [alias]: {} };
      body = payload({
        [`${alias}_HORIZONTAL`]: { JAN: 0, ANN: 2 },
        [`${alias}_OPTIMAL_ANG_ORT`]: { JAN: 'S', ANN: 'N' },
      });
      const result = await settle(
        runRaw(getClimatologyTool, {
          latitude: 47,
          longitude: -122,
          selection: { mode: 'parameters', parameters: [alias] },
        }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        expansions: { [alias]: [`${alias}_HORIZONTAL`, `${alias}_OPTIMAL_ANG_ORT`] },
        omittedParameters: [],
        metadata: { messages: [message] },
        rows: [{ [`${alias}_OPTIMAL_ANG_ORT`]: 'S' }, { [`${alias}_OPTIMAL_ANG_ORT`]: 'N' }],
      });
      const rendered = markdownText(text(result));
      expect(rendered).toContain(alias);
      expect(rendered).toContain(`${alias}_OPTIMAL_ANG_ORT`);
      expect(rendered).toContain(message);
    },
  );
  it.each([
    [
      'climatology hour-extreme and tracker groups',
      getClimatologyTool,
      {},
      {
        ALLSKY_SFC_SW_DWN_HR_MAX: ['ALLSKY_SFC_SW_DWN_00_MAX', 'ALLSKY_SFC_SW_DWN_23_MAX'],
        SI_TRACKER_AVG: ['SI_TRACKER_AVG_DUAL', 'SI_TRACKER_AVG_VSAT'],
      },
      { JAN: 1, ANN: 2 },
    ],
    [
      'a monthly hour group',
      getTimeseriesTool,
      { temporalResolution: 'monthly', startYear: 2023, endYear: 2023 },
      { ALLSKY_SFC_SW_DWN_HR: ['ALLSKY_SFC_SW_DWN_00', 'ALLSKY_SFC_SW_DWN_23'] },
      { '202301': 1, '202313': 2 },
    ],
  ] as const)(
    'reports returned %s under expansions on both surfaces',
    async (_shape, definition, window, expansions, values) => {
      const members: readonly string[] = Object.values(expansions).flat();
      entries = Object.fromEntries(Object.keys(expansions).map((alias) => [alias, {}]));
      body = payload(Object.fromEntries(members.map((code) => [code, values])));
      const result = await settle(
        runRaw(definition, {
          latitude: 41.9,
          longitude: -93.6,
          ...window,
          selection: { mode: 'parameters', parameters: Object.keys(expansions) },
        }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ expansions, omittedParameters: [] });
      expect(text(result)).not.toContain('[` code `, ` messages `]');
      for (const code of members) expect(text(result)).toContain(code);
    },
  );
  it.each([
    [
      getClimatologyTool,
      { community: 'AG', selection: { mode: 'parameters', parameters: ['GDD10'] } },
      ['GDD10'],
      'daily',
    ],
    [
      getTimeseriesTool,
      {
        temporalResolution: 'monthly',
        startYear: 2023,
        endYear: 2023,
        selection: { mode: 'parameters', parameters: ['T2M', 'ALLSKY_SFC_SW_DWN_HR_MIN'] },
      },
      ['ALLSKY_SFC_SW_DWN_HR_MIN'],
      'climatology',
    ],
  ] as const)(
    'refuses codes POWER lists but does not serve, on both surfaces, before any request (%#)',
    async (definition, args, parameters, recovery) => {
      entries = Object.fromEntries(['T2M', ...parameters].map((code) => [code, {}]));
      const result = await settle(
        runRaw(definition, { latitude: 41.9, longitude: -93.6, ...args }),
      );
      failure(result, 'unsupported_parameter');
      expect(result.structuredContent).toMatchObject({
        error: { data: { parameters, recovery: { hint: expect.stringContaining(recovery) } } },
      });
      for (const code of parameters) expect(text(result)).toContain(code);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('publishes canonical wind long names and resolution-specific preset expansions on both paths', async () => {
    const wind = await runToolContract(listReferenceTool, { topic: 'wind_surfaces' });
    expect(wind.structuredContent).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ code: 'airportgrass', description: 'Airport: flat rough grass' }),
        expect.objectContaining({
          code: 'vegtype_1',
          description: '35-m broadleaf-evergreen trees (70% coverage)',
        }),
        expect.objectContaining({ code: 'airportice', aliases: ['airport_ice', 'airport ice'] }),
      ]),
    });
    const windEntries = (
      wind.structuredContent as { entries: { code: string; description: string }[] }
    ).entries;
    expect(windEntries.filter((entry) => !['WSC', 'PSC'].includes(entry.code))).toHaveLength(17);
    for (const entry of windEntries) expect(text(wind)).toContain(entry.description);
    const presets = await runToolContract(listReferenceTool, { topic: 'presets' });
    expect(presets.structuredContent).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          code: 'agroclimatology',
          resolutions: ['hourly'],
          parameters: ['T2M', 'PRECTOTCORR', 'GWETROOT', 'GWETPROF', 'ALLSKY_SFC_SW_DWN'],
        }),
        expect.objectContaining({
          code: 'agroclimatology',
          resolutions: ['daily', 'monthly', 'climatology'],
          parameters: [
            'T2M',
            'PRECTOTCORR',
            'GWETROOT',
            'GWETPROF',
            'ALLSKY_SFC_SW_DWN',
            'T2M_MAX',
            'T2M_MIN',
          ],
        }),
      ]),
    });
    expect(text(presets)).toContain('T2M_MIN');
    expect(text(presets)).toContain('not reconstructed daily records');
    const agro = (
      presets.structuredContent as {
        entries: { code: string; resolutions?: string[]; description: string }[];
      }
    ).entries.find(
      (entry) => entry.code === 'agroclimatology' && entry.resolutions?.[0] === 'daily',
    );
    expect(agro?.description).toMatch(/GDD\*.*daily/);
    expect(markdownText(text(presets))).toContain(agro?.description);
  });
  it.each([
    'airportgrass',
    'airportice',
    'seaice',
    'openwater',
    ...Array.from({ length: 12 }, (_, i) => `vegtype_${i + 1}`),
    'vegtype_20',
  ])('sends canonical wind surface %s unchanged on both paths', async (windSurface) => {
    const result = await settle(
      runRaw(getTimeseriesTool, { ...input, windElevation: 100, windSurface }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ request: { windSurface } });
    expect(new URL(String(fetcher.mock.calls.at(-1)?.[0])).searchParams.get('wind-surface')).toBe(
      windSurface,
    );
    expect(text(result)).toContain(windSurface);
  });
  it('deduplicates normalized scientific codes without losing request provenance', async () => {
    const result = await settle(
      runToolContract(getTimeseriesTool, {
        ...input,
        selection: { mode: 'parameters', parameters: ['t2m', ' T2M ', 'rh2m'] },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      request: { selection: { parameters: ['T2M', 'RH2M'] } },
    });
    expect(new URL(String(fetcher.mock.calls.at(-1)?.[0])).searchParams.get('parameters')).toBe(
      'T2M,RH2M',
    );
    expect(text(result)).toContain('RH2M');
  });
  it.each([0, 100, 250])(
    'clamps discovery limits and discloses the effective cap at offset %s',
    async (offset) => {
      entries = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`P${i}`, {}]));
      const result = await runRaw(searchParametersTool, { limit: 101, offset });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        limit: 100,
        total: 120,
        offset,
        entries: expect.any(Array),
        hasMore: offset === 0,
        truncated: offset === 0,
        notice: 'The effective entry limit is 100; larger requested limits are capped.',
      });
      expect((result.structuredContent as { entries: unknown[] }).entries).toHaveLength(
        offset === 0 ? 100 : offset === 100 ? 20 : 0,
      );
      expect(text(result)).toContain(
        'The effective entry limit is 100; larger requested limits are capped.',
      );
    },
  );
  it('marks upstream 429 retryable for the caller while stopping this call', async () => {
    fetcher.mockImplementationOnce(async () =>
      Response.json({ messages: ['slow down'] }, { status: 429, headers: { 'Retry-After': '2' } }),
    );
    const result = await settle(runToolContract(searchParametersTool, {}));
    failure(result, 'upstream_rate_limited');
    expect(result.structuredContent).toMatchObject({
      error: { data: { retryable: true, status: 429, retryAfter: '2', messages: ['slow down'] } },
    });
    expect(text(result)).toContain('slow down');
    expect(text(result)).not.toContain('not retryable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(
    (['RE', 'SB', 'AG'] as const).flatMap((community) =>
      (['hourly', 'daily', 'monthly', 'climatology'] as const).map((temporalResolution) => ({
        community,
        temporalResolution,
      })),
    ),
  )(
    'uses the exact agroclimatology expansion for $community/$temporalResolution',
    async ({ community, temporalResolution }) => {
      const extremes = temporalResolution === 'hourly' ? {} : { T2M_MAX: {}, T2M_MIN: {} };
      entries = { ...dictionary, ...extremes };
      body = payload(extremes);
      const window =
        temporalResolution === 'daily' || temporalResolution === 'hourly'
          ? { startDate: '2024-01-01', endDate: '2024-01-02' }
          : { startYear: 2024, endYear: 2024 };
      const result = await settle(
        runRaw(temporalResolution === 'climatology' ? getClimatologyTool : getTimeseriesTool, {
          latitude: 47,
          longitude: -122,
          community,
          ...(temporalResolution === 'climatology' ? {} : { temporalResolution }),
          ...window,
          selection: { mode: 'preset', preset: 'agroclimatology' },
        }),
      );
      expect(result.isError).not.toBe(true);
      expect(
        new URL(String(fetcher.mock.calls.at(-1)?.[0])).searchParams.get('parameters')?.split(','),
      ).toEqual([
        'T2M',
        'PRECTOTCORR',
        'GWETROOT',
        'GWETPROF',
        'ALLSKY_SFC_SW_DWN',
        ...(temporalResolution === 'hourly' ? [] : ['T2M_MAX', 'T2M_MIN']),
      ]);
      if (temporalResolution !== 'hourly') {
        expect(text(result)).toContain('T2M_MAX');
        expect(result.structuredContent).toMatchObject({
          parameters: expect.arrayContaining([expect.objectContaining({ code: 'T2M_MAX' })]),
        });
      }
    },
  );
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    body = payload({ T2M: { '20240101': 0, '20240102': -999 } });
    entries = dictionary;
    status = 200;
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

  it('preserves missing, omitted, nested and literal source values on both paths', async () => {
    const result = await settle(
      runToolContract(getTimeseriesTool, {
        ...input,
        selection: { mode: 'parameters', parameters: [' t2m ', 'RH2M'] },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      rowCount: 2,
      dataset: null,
      request: {
        community: 'RE',
        units: 'metric',
        timeStandard: 'LST',
        selection: { parameters: ['T2M', 'RH2M'] },
      },
      rows: [{ T2M: 0, elevation: null }, { T2M: null }],
      omittedParameters: [{ code: 'RH2M', messages: [message] }],
      summaries: [{ validCount: 1, fillCount: 1, absentKeyCount: 0, mean: 0 }],
      parameters: [{ longName: message, extra: { nested: { retained: [null, 0, message] } } }],
    });
    expect(text(result)).toContain(message);
    expect(text(result)).toContain('[https://example.com/source](<https://example.com/source>)');
    for (const field of ['omittedParameters', 'fillCount', 'rowCount', 'endpointUrl'])
      expect(text(result)).toContain(field);
  });

  it('defaults omitted temporal resolution to daily', async () => {
    const { temporalResolution: _resolution, ...daily } = input;
    const result = await settle(runToolContract(getTimeseriesTool, daily));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ request: { temporalResolution: 'daily' } });
  });

  it('keeps absent periods distinct from fills in each parameter summary', async () => {
    body = payload({ T2M: { '20240101': 0, '20240102': -999 }, RH2M: { '20240101': 20 } });
    const result = await settle(
      runToolContract(getTimeseriesTool, {
        ...input,
        selection: { mode: 'parameters', parameters: ['T2M', 'RH2M'] },
      }),
    );
    expect(result.structuredContent).toMatchObject({
      rows: [
        { RH2M: 20, T2M: 0 },
        { RH2M: null, T2M: null },
      ],
      summaries: expect.arrayContaining([
        expect.objectContaining({ parameter: 'T2M', fillCount: 1, absentKeyCount: 0 }),
        expect.objectContaining({ parameter: 'RH2M', fillCount: 0, absentKeyCount: 1 }),
      ]),
    });
    expect(text(result)).toContain('absentKeyCount');
  });

  it.each([
    ['hourly', 15],
    ['daily', 20],
  ] as const)(
    'accepts the exact %s parameter cap before correction additions',
    async (temporalResolution, count) => {
      const parameters = Array.from({ length: count }, (_, index) => `P${index}`);
      entries = Object.fromEntries(parameters.map((code) => [code, {}]));
      body = payload({});
      const result = await settle(
        runRaw(getTimeseriesTool, {
          ...input,
          temporalResolution,
          selection: { mode: 'parameters', parameters },
        }),
      );
      expect(result.isError).not.toBe(true);
      const corrected = await settle(
        runRaw(getTimeseriesTool, {
          ...input,
          temporalResolution,
          selection: { mode: 'parameters', parameters },
          siteElevation: 1,
        }),
      );
      failure(corrected, 'unsupported_parameter');
    },
  );

  it('rejects an unpaired climatology year and validates a custom product range', async () => {
    failure(
      await settle(
        runToolContract(getClimatologyTool, { latitude: 47, longitude: -122, startYear: 2020 }),
      ),
      'invalid_window',
    );
    body = payload({ T2M: { JAN: 1, ANN: 2 } });
    const result = await settle(
      runToolContract(getClimatologyTool, {
        latitude: 47,
        longitude: -122,
        startYear: 2020,
        endYear: 2023,
        selection: input.selection,
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ request: { startYear: 2020, endYear: 2023 } });
    const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]));
    expect(url.searchParams.get('start')).toBe('2020');
    expect(url.searchParams.get('end')).toBe('2023');
  });

  it.each([
    [
      'hourly',
      { startDate: '2024-01-01', endDate: '2024-01-01' },
      { '2024010100': 2, '2024010101': 4 },
      ['hour', 'hour'],
    ],
    [
      'monthly',
      { startYear: 2024, endYear: 2024 },
      { '202401': 2, '202402': 4, '202413': 90 },
      ['month', 'month', 'annual'],
    ],
  ] as const)(
    'retains %s periods and separates annual statistics',
    async (resolution, window, series, kinds) => {
      body = payload({ T2M: series });
      const result = await settle(
        runRaw(getTimeseriesTool, {
          temporalResolution: resolution,
          latitude: 47,
          longitude: -122,
          selection: input.selection,
          ...window,
        }),
      );
      expect(result.isError).not.toBe(true);
      const data = result.structuredContent as {
        rows: { periodKind: string }[];
        summaries: { mean: number }[];
      };
      expect(data.rows.map((row) => row.periodKind)).toEqual(kinds);
      expect(data.summaries.map((summary) => summary.mean)).toEqual(
        resolution === 'monthly' ? [3, 90] : [3],
      );
      for (const kind of kinds) expect(text(result)).toContain(kind);
    },
  );

  it('retains dynamic tilted orientation and source climatology range inline', async () => {
    body = {
      ...payload({
        SI_TILTED_AVG_OPTIMAL: { JAN: 2, ANN: 8 },
        SI_TILTED_AVG_OPTIMAL_ANG_ORT: { JAN: message, ANN: 'N' },
      }),
      header: { ...body.header, range: 'source product range' },
    } as typeof body;
    const result = await settle(
      runToolContract(getClimatologyTool, {
        latitude: 47,
        longitude: -122,
        selection: { mode: 'parameters', parameters: ['SI_EF_TILTED_SURFACE'] },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      dataset: null,
      rowCount: 2,
      metadata: { range: 'source product range' },
      expansions: {
        SI_EF_TILTED_SURFACE: ['SI_TILTED_AVG_OPTIMAL', 'SI_TILTED_AVG_OPTIMAL_ANG_ORT'],
      },
      rows: [{ SI_TILTED_AVG_OPTIMAL_ANG_ORT: message }, { SI_TILTED_AVG_OPTIMAL_ANG_ORT: 'N' }],
    });
    const data = result.structuredContent as { summaries: { parameter: string }[] };
    expect(data.summaries.every((summary) => !summary.parameter.endsWith('_ORT'))).toBe(true);
    expect(text(result)).toContain(message);
    expect(text(result)).toContain('source product range');
    expect(new URL(String(fetcher.mock.calls.at(-1)?.[0])).searchParams.has('start')).toBe(false);
  });

  it.each(['airport_ice', 'airport ice', 'airportice'] as const)(
    'normalizes wind alias %s and adds correction once',
    async (windSurface) => {
      const result = await settle(
        runToolContract(getTimeseriesTool, {
          ...input,
          windElevation: 50,
          windSurface,
          siteElevation: 0,
        }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ request: { windSurface: 'airportice' } });
      const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]));
      expect(url.searchParams.get('parameters')).toBe('T2M,PSC,WSC');
      expect(url.searchParams.get('wind-surface')).toBe('airportice');
    },
  );

  it.each([
    [{ endDate: '2023-12-31' }, 'invalid_window'],
    [{ windElevation: 50 }, 'invalid_correction'],
    [{ windElevation: 100, windSurface: 'grass' }, 'invalid_arguments'],
    [{ selection: { mode: 'parameters', parameters: ['PSC'] } }, 'invalid_correction'],
    [{ selection: { mode: 'parameters', parameters: ['UNKNOWN'] } }, 'unsupported_parameter'],
    [
      { temporalResolution: 'hourly', selection: { mode: 'preset', preset: 'building_hvac' } },
      'unsupported_preset',
    ],
    [
      {
        temporalResolution: 'hourly',
        selection: {
          mode: 'parameters',
          parameters: Array.from({ length: 16 }, (_, i) => `P${i}`),
        },
      },
      'invalid_arguments',
    ],
  ])('returns actionable declared failure for %j', async (extra, reason) => {
    const result = await settle(runRaw(getTimeseriesTool, { ...input, ...extra }));
    failure(result, reason);
  });

  it('returns empty observations without inventing rows or statistics', async () => {
    body = payload({});
    const result = await settle(runToolContract(getTimeseriesTool, input));
    expect(result.structuredContent).toMatchObject({
      rows: [],
      summaries: [],
      rowCount: 0,
      omittedParameters: [{ code: 'T2M' }],
    });
    expect(text(result)).toContain('omittedParameters');
  });

  it('returns actionable canvas_required when complete daily data exceeds inline bounds', async () => {
    body = payload({
      T2M: Object.fromEntries(
        Array.from({ length: 366 }, (_, i) => {
          const key = new Date(Date.UTC(2024, 0, i + 1))
            .toISOString()
            .slice(0, 10)
            .replaceAll('-', '');
          return [key, i];
        }),
      ),
    });
    failure(
      await settle(runToolContract(getTimeseriesTool, { ...input, endDate: '2024-12-31' })),
      'canvas_required',
    );
  });

  it.each([400, 422, 429])(
    'retains upstream %s diagnostics in both failure paths',
    async (code) => {
      status = code;
      const result = await settle(runToolContract(getTimeseriesTool, input));
      failure(result, code === 429 ? 'upstream_rate_limited' : 'upstream_rejected');
      expect(result.structuredContent).toMatchObject({ error: { data: { messages: [message] } } });
      expect(markdownText(text(result))).toContain(message);
    },
  );

  it.each([
    { ...input, latitude: 91 },
    { ...input, community: 're' },
    { ...input, timeStandard: 'utc' },
    { ...input, startDate: '2024-02-30' },
  ])('rejects invalid public input %j before fetching', async (args) => {
    const result = await runRaw(getTimeseriesTool, args);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('filters every token against the complete dictionary before sorted pagination', async () => {
    entries = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [
        `P${String(i).padStart(3, '0')}`,
        { name: 'Air Temperature', definition: i % 2 ? `Depth ${message}` : 'Surface' },
      ]),
    );
    const result = await settle(
      runToolContract(searchParametersTool, { filter: 'AIR depth', offset: 2, limit: 2 }),
    );
    expect(result.structuredContent).toMatchObject({
      community: 'RE',
      temporalResolution: 'daily',
      total: 60,
      hasMore: true,
      truncated: true,
      entries: [{ code: 'P005' }, { code: 'P007' }],
    });
    expect(text(result)).toContain(`Depth ${message}`);
    expect(text(result)).toContain('P007');
  });

  /** Exact representative records captured from NASA monthly/climatology RE dictionaries. */
  const nullableDictionary = (resolution: 'monthly' | 'climatology') => ({
    AIRMASS_HR: {
      type: null,
      temporal: resolution.toUpperCase(),
      source: null,
      community: 'RE',
      calculated: false,
      inputs: null,
      units: null,
      name: 'Air Mass (Hour-Based Parameter Set)',
      definition: null,
    },
    ...(resolution === 'climatology'
      ? {
          SI_TILTED_AVG: {
            type: null,
            temporal: 'CLIMATOLOGY',
            source: 'POWER',
            community: 'RE',
            calculated: true,
            inputs:
              "['ALLSKY_SFC_SW_DWN_HR', 'ALLSKY_SFC_SW_DIFF_HR', 'ALLSKY_SFC_SW_DNI_HR', 'ALLSKY_SRF_ALB_HR', 'SG_SZA_HR', 'SG_SAA_HR']",
            units: null,
            name: null,
            definition: null,
          },
        }
      : {}),
    T2M: {
      type: 'METEOROLOGY',
      temporal: resolution.toUpperCase(),
      source: 'SOURCE',
      community: 'RE',
      calculated: false,
      inputs: null,
      units: 'C',
      name: 'Temperature at 2 Meters',
      definition:
        'The average air (dry bulb) temperature at 2 meters above the surface of the earth.',
    },
  });

  it.each(['monthly', 'climatology'] as const)(
    'preserves nullable %s dictionary metadata while filtering and paging',
    async (temporalResolution) => {
      const captured = nullableDictionary(temporalResolution);
      entries = captured;
      const browse = await settle(
        runToolContract(searchParametersTool, { temporalResolution, limit: 1 }),
      );
      expect(browse.isError).not.toBe(true);
      expect(browse.structuredContent).toMatchObject({
        total: Object.keys(captured).length,
        hasMore: true,
        entries: [{ code: 'AIRMASS_HR', ...captured.AIRMASS_HR }],
      });
      const orderedColumns =
        'Records with ordered columns [` type `, ` temporal `, ` source `, ` community `, ` calculated `, ` inputs `, ` units `, ` name `, ` definition `, ` code `]';
      expect(text(browse)).toContain(orderedColumns);
      expect(text(browse)).toContain(
        `[null, \` ${temporalResolution.toUpperCase()} \`, null, \` RE \`, false, null, null, \` Air Mass (Hour-Based Parameter Set) \`, null, \` AIRMASS_HR \`]`,
      );
      const filtered = await runToolContract(searchParametersTool, {
        temporalResolution,
        filter: 'temperature 2',
        limit: 1,
      });
      expect(filtered.structuredContent).toMatchObject({
        total: 1,
        hasMore: false,
        entries: [{ code: 'T2M', ...captured.T2M }],
      });
      expect(text(filtered)).toContain(captured.T2M.definition);
      const last = await runToolContract(searchParametersTool, {
        temporalResolution,
        offset: Object.keys(captured).length - 1,
        limit: 1,
      });
      expect(last.structuredContent).toMatchObject({
        hasMore: false,
        entries: [{ code: 'T2M' }],
      });
      if (temporalResolution === 'climatology') {
        const tilted = await runToolContract(searchParametersTool, {
          temporalResolution,
          filter: 'SI_TILTED_AVG',
        });
        expect(tilted.structuredContent).toMatchObject({
          total: 1,
          entries: [{ code: 'SI_TILTED_AVG', ...captured.SI_TILTED_AVG }],
        });
        expect(text(tilted)).toContain(orderedColumns);
        expect(text(tilted)).toContain(
          "[null, ` CLIMATOLOGY `, ` POWER `, ` RE `, true, ` ['ALLSKY_SFC_SW_DWN_HR', 'ALLSKY_SFC_SW_DIFF_HR', 'ALLSKY_SFC_SW_DNI_HR', 'ALLSKY_SRF_ALB_HR', 'SG_SZA_HR', 'SG_SAA_HR'] `, null, null, null, ` SI_TILTED_AVG `]",
        );
      }
    },
  );

  it.each(['monthly', 'climatology'] as const)(
    'allows valid %s T2M data preflight with unrelated nullable dictionary entries',
    async (temporalResolution) => {
      entries = nullableDictionary(temporalResolution);
      body = payload({ T2M: temporalResolution === 'monthly' ? { '202401': 3 } : { JAN: 3 } });
      const result = await settle(
        temporalResolution === 'monthly'
          ? runToolContract(getTimeseriesTool, {
              temporalResolution,
              latitude: 47,
              longitude: -122,
              startYear: 2024,
              endYear: 2024,
              selection: input.selection,
            })
          : runToolContract(getClimatologyTool, {
              latitude: 47,
              longitude: -122,
              selection: input.selection,
            }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ rowCount: 1, rows: [{ T2M: 3 }] });
      expect(text(result)).toContain('T2M');
      expect(text(result)).toContain('3');
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it.each(['type', 'source', 'units', 'name', 'definition'] as const)(
    'rejects number and object dictionary %s values without weakening string validation',
    async (field) => {
      for (const invalid of [42, { invalid: true }]) {
        source.dispose();
        source = initPowerService({
          fetch: fetcher,
          config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
        });
        entries = { T2M: { [field]: invalid } };
        const result = await settle(
          runToolContract(searchParametersTool, { temporalResolution: 'monthly' }),
        );
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.SerializationError },
        });
        expect(text(result)).toContain(`T2M.${field}`);
      }
    },
  );

  it('browses blank filters to maximum 100 and handles offset past the end', async () => {
    entries = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`P${String(i).padStart(3, '0')}`, { inputs: null }]),
    );
    const first = await settle(runToolContract(searchParametersTool, { filter: '  ', limit: 100 }));
    expect(first.structuredContent).toMatchObject({ total: 120, hasMore: true, truncated: true });
    expect((first.structuredContent as { entries: unknown[] }).entries).toHaveLength(100);
    const last = await runToolContract(searchParametersTool, { offset: 130 });
    expect(last.structuredContent).toMatchObject({
      total: 120,
      entries: [],
      hasMore: false,
      truncated: false,
    });
    expect(text(last)).toContain('120');
  });

  describe('codes POWER lists but does not serve', () => {
    const gdd = ['GDD10', 'GDD13_3', 'GDD15_6', 'GDD4_4', 'GDD7_2'];
    beforeEach(() => {
      entries = {
        ...Object.fromEntries(
          gdd.map((code) => [code, { name: `Growing Degree Days ${code.slice(3)} C` }]),
        ),
        HDD18_3: { name: 'Heating Degree Days Below 18.3 C' },
        ALLSKY_SFC_SW_DWN_HR_MAX: { name: 'All Sky Irradiance Hour-Based Maximum' },
      };
    });
    it.each([
      ['daily', gdd],
      ['monthly', []],
      ['climatology', []],
    ] as const)(
      'offers growing degree days only where POWER serves them: %s',
      async (temporalResolution, codes) => {
        const result = await settle(
          runToolContract(searchParametersTool, { temporalResolution, filter: 'growing degree' }),
        );
        expect(result.structuredContent).toMatchObject({
          total: codes.length,
          hasMore: false,
          entries: codes.map((code) => ({ code })),
        });
        if (temporalResolution === 'daily')
          expect(result.structuredContent).not.toHaveProperty('notice');
        else {
          const { notice } = result.structuredContent as { notice: string };
          expect(notice).toMatch(/GDD10.*daily/s);
          expect(notice).not.toContain('No parameters matched');
          expect(text(result)).toContain(notice);
        }
      },
    );
    it.each([
      ['monthly', ['HDD18_3']],
      ['climatology', ['ALLSKY_SFC_SW_DWN_HR_MAX', 'HDD18_3']],
    ] as const)(
      'counts and pages %s browsing after the exclusion',
      async (temporalResolution, codes) => {
        for (const [offset, expected] of [...codes, undefined].entries()) {
          const page = await settle(
            runToolContract(searchParametersTool, { temporalResolution, offset, limit: 1 }),
          );
          expect(page.structuredContent).toMatchObject({
            total: codes.length,
            hasMore: offset + 1 < codes.length,
            entries: expected ? [{ code: expected }] : [],
          });
        }
      },
    );
  });

  it('carries zero-hit guidance through enrichment to both consumption paths', async () => {
    const result = await settle(
      runToolContract(searchParametersTool, { filter: 'no-such-parameter' }),
    );
    expect(result.structuredContent).toMatchObject({
      entries: [],
      total: 0,
      notice: expect.stringContaining('No parameters matched'),
    });
    expect(text(result)).toContain('No parameters matched');
  });

  it('returns actionable queue admission failures through the discovery contract', async () => {
    fetcher.mockImplementationOnce(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = Array.from({ length: 34 }, () => runToolContract(searchParametersTool, {}));
    await vi.advanceTimersByTimeAsync(0);
    failure(await pending.at(-1)!, 'request_queue_full');
    source.dispose();
    await Promise.all(pending);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('completes four overlapping small monthly calls at four points without a refusal', async () => {
    const fake = fakePower(['T2M']);
    source.dispose();
    source = initPowerService({
      fetch: fake.fetch,
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
    const points = [
      [47.6, -122.3],
      [40.7, -74],
      [34, -118.2],
      [41.9, -87.6],
    ] as const;
    const pending = points.map(([latitude, longitude]) =>
      runToolContract(getTimeseriesTool, {
        temporalResolution: 'monthly',
        latitude,
        longitude,
        startYear: 2019,
        endYear: 2019,
        selection: { mode: 'parameters', parameters: ['T2M'] },
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    for (const result of await Promise.all(pending)) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ rowCount: 13, dataset: null });
    }
    expect(fake.requests).toHaveLength(4);
  });

  it('refuses a small call still waiting behind a stalled worst-case comparison with producer_capacity_exhausted before it reaches NASA', async () => {
    fetcher.mockImplementation(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    /** Two sites, every hour since 2001, the 15-code hourly maximum: capped at the whole tenant budget. */
    const worst = runToolContract(compareLocationsTool, {
      temporalResolution: 'hourly',
      startDate: '2001-01-01',
      endDate: '2026-10-18',
      locations: [
        { latitude: 1, longitude: 1, label: 'a' },
        { latitude: 2, longitude: 2, label: 'b' },
      ],
      selection: {
        mode: 'parameters',
        parameters: Array.from({ length: 15 }, (_, i) => `P${i}`),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const small = runToolContract(getTimeseriesTool, input);
    await vi.advanceTimersByTimeAsync(15_000);
    const refused = await small;
    failure(refused, 'producer_capacity_exhausted');
    expect(refused.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RateLimited, data: { retryable: true } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    source.dispose();
    await worst;
  });

  it('completes a retried large-body call while another call holds the rest of the tenant budget', async () => {
    const MiB = 1024 * 1024;
    const json = JSON.stringify(payload({ T2M: { '20240101': 0, '20240102': 1 } }));
    let attempts = 0;
    source.dispose();
    source = initPowerService({
      fetch: async (url) => {
        if (String(url).includes('/parameters?')) return Response.json(entries);
        if (String(url).endsWith('/configuration'))
          return Response.json({ settings: { start: '1981-01-01', end: '2025-12-31' } });
        attempts++;
        return attempts === 1
          ? streamedBody(12 * MiB, 'error')
          : new Response(json + ' '.repeat(13 * MiB));
      },
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
    /** Leaves this call 20 MiB: the 13 MiB body it keeps fits, the 12 + 13 MiB it decoded would not. */
    const hold = Promise.withResolvers<void>();
    const holder = canvas.withProducer(
      POWER_LIMITS.tenantInflightBytes - 20 * MiB,
      createMockContext(),
      () => hold.promise,
    );
    try {
      const pending = runToolContract(getTimeseriesTool, input);
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;
      expect(result.structuredContent).toMatchObject({ rowCount: 2, dataset: null });
      expect(result.isError).not.toBe(true);
      expect(attempts).toBe(2);
    } finally {
      hold.resolve();
      await holder;
    }
  });

  it.each([
    [
      'a daily year',
      { temporalResolution: 'daily', startDate: '2024-01-01', endDate: '2024-12-31' },
      366,
    ],
    [
      'an hourly month',
      { temporalResolution: 'hourly', startDate: '2024-01-01', endDate: '2024-01-31' },
      744,
    ],
    ['a monthly span', { temporalResolution: 'monthly', startYear: 1990, endYear: 2024 }, 455],
  ] as const)(
    'sizes the canvas_required refusal for %s and every listed call re-sent fits inline',
    async (_shape, window, rowCount) => {
      const fake = fakePower(['T2M']);
      source.dispose();
      source = initPowerService({
        fetch: fake.fetch,
        config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
      });
      const args = {
        latitude: 47.6,
        longitude: -122.3,
        selection: { mode: 'parameters', parameters: ['T2M'] },
        ...window,
      };
      const refused = await settle(runRaw(getTimeseriesTool, args));
      const split = sizedRefusal(refused, rowCount);
      const keys = new Set<string>();
      let delivered = 0;
      for (const call of split.calls) {
        expect(Object.keys(call).sort()).toEqual(
          window.temporalResolution === 'monthly'
            ? ['endYear', 'startYear']
            : ['endDate', 'startDate'],
        );
        const result = await settle(runRaw(getTimeseriesTool, { ...args, ...call }));
        expect(result.isError).not.toBe(true);
        const output = result.structuredContent as {
          rowCount: number;
          dataset: null;
          rows: { periodKey: string }[];
        };
        expect(output).toMatchObject({ dataset: null, rowCount: output.rows.length });
        expect(output.rowCount).toBeLessThanOrEqual(split.inlineRows);
        delivered += output.rowCount;
        for (const row of output.rows) keys.add(row.periodKey);
      }
      expect(delivered).toBe(rowCount);
      expect(keys.size).toBe(rowCount);
      const [first, last] = [split.calls[0], split.calls.at(-1)];
      expect(first).toMatchObject(
        'startYear' in window ? { startYear: window.startYear } : { startDate: window.startDate },
      );
      expect(last).toMatchObject(
        'endYear' in window ? { endYear: window.endYear } : { endDate: window.endDate },
      );
    },
  );

  it.each([
    { limit: 1.5 },
    { limit: 0 },
    { limit: -1 },
    { offset: -1 },
    { filter: 'x'.repeat(257) },
    { community: 're' },
  ])('rejects invalid search boundary %j', async (args) => {
    const result = await runRaw(searchParametersTool, args);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'presets',
    'communities',
    'coverage',
    'missing_data',
    'wind_surfaces',
    'dataframes',
  ] as const)('renders all %s reference fields without network access', async (topic) => {
    const result = await runToolContract(listReferenceTool, { topic });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      topic,
      verifiedOn: '2026-10-28',
      entries: expect.any(Array),
    });
    const data = result.structuredContent as {
      entries: { code: string; description: string }[];
      guidance: string[];
    };
    for (const entry of data.entries) {
      expect(text(result)).toContain(entry.code);
      expect(text(result)).toContain(entry.description);
    }
    for (const guidance of data.guidance) expect(text(result)).toContain(guidance);
    expect(text(result)).toContain(
      '[https://power.larc.nasa.gov/docs/services/api/](<https://power.larc.nasa.gov/docs/services/api/>)',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
