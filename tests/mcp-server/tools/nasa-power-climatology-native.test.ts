/** @fileoverview Captured climatology retrieval and explicit native token reuse. @module tests/mcp-server/tools/nasa-power-climatology-native */
import { readFile } from 'node:fs/promises';
import { type MockContextOptions, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getClimatologyTool } from '@/mcp-server/tools/definitions/nasa-power-get-climatology.tool.js';
import { getTimeseriesTool } from '@/mcp-server/tools/definitions/nasa-power-get-timeseries.tool.js';
import { PointOutputSchema } from '@/mcp-server/tools/definitions/point-contracts.js';
import { formatFaithfully } from '@/services/canvas/format.js';
import { initCanvasService } from '@/services/canvas/index.js';
import { initPowerService } from '@/services/power/index.js';
import { normalizePoint, PointPayloadSchema } from '@/services/power/normalize.js';
import { aliasMembership } from '@/services/power/presets.js';
import { PowerRequestSchema } from '@/services/power/types.js';
import { nativeFixture } from '../../services/canvas/fixture.js';
import { sizedRefusal } from '../../sized-refusal.js';

const parameters = [
  'SI_TILTED_AVG',
  'SI_TILTED_MIN',
  'SI_TILTED_MAX',
  'T2M',
  'T2M_MAX',
  'T2M_MIN',
  'RH2M',
  'PRECTOTCORR',
  'GWETROOT',
  'GWETPROF',
  'WS10M',
  'WS50M',
  'PS',
  'HDD18_3',
  'CDD18_3',
];
const args = {
  latitude: 47.6,
  longitude: -122.3,
  selection: { mode: 'parameters' as const, parameters },
};
/** Two hour-of-day groups and a tracker group beside ordinary codes: 58 returned columns. */
const wideCodes = [
  'ALLSKY_SFC_SW_DWN_HR',
  'ALLSKY_SFC_SW_DIFF_HR',
  'SI_TRACKER_AVG',
  'T2M',
  'RH2M',
  'WS10M',
  'PS',
  'PRECTOTCORR',
];
const wideArgs = {
  latitude: 41.9,
  longitude: -93.6,
  selection: { mode: 'parameters' as const, parameters: wideCodes },
};
/** Two hour-of-day groups beside eleven codes POWER serves monthly: 59 returned columns. */
const monthlyArgs = {
  temporalResolution: 'monthly' as const,
  latitude: 41.9,
  longitude: -93.6,
  startYear: 2020,
  endYear: 2020,
  selection: {
    mode: 'parameters' as const,
    parameters: [
      'ALLSKY_SFC_SW_DWN_HR',
      'ALLSKY_SFC_SW_DIFF_HR',
      'T2M',
      'RH2M',
      'WS10M',
      'PS',
      'PRECTOTCORR',
      'T2M_MAX',
      'T2M_MIN',
      'QV2M',
      'WS50M',
      'WD10M',
      'T2MDEW',
    ],
  },
};
const readFixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));
const readWide = () => readFixture('hour-wide-climatology.json');
/** The complete dataset the current capture normalizes to for a request. */
const normalized = (request: object = { ...wideArgs, temporalResolution: 'climatology' }) =>
  normalizePoint(PointPayloadSchema.parse(raw), PowerRequestSchema.parse(request), {
    endpointUrl: 'https://power.larc.nasa.gov/',
    fetchedAt: '2026-10-29T00:00:00Z',
    cacheHit: false,
  });
/** Every summary the captured wide profile normalizes to, in response order. */
const wideSummaries = () => normalized().summaries;
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let source: ReturnType<typeof initPowerService>;
let raw: {
  properties: { parameter: Record<string, Record<string, number | string>> };
  [key: string]: unknown;
};
const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
const run = (extra: Record<string, unknown> = {}, context: MockContextOptions = {}) =>
  runToolContract(
    getClimatologyTool,
    { ...args, ...extra } as Parameters<typeof runToolContract<typeof getClimatologyTool>>[1],
    { context },
  );
const withoutWorkspace = () =>
  initCanvasService({
    storage: fixture.storage,
    config: { dataframeDropEnabled: false, maxCanvasesPerProcess: 8 },
  });
async function settle<T>(result: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(6000);
  return result;
}
/** The captured payload narrowed to the codes a request names, as POWER answers a narrower list. */
function requested(url: URL) {
  const codes = (url.searchParams.get('parameters') ?? '').split(',');
  const keep = (key: string) =>
    codes.some((code) => key === code || aliasMembership(code)?.(key) === true);
  const narrow = (record: object) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)));
  return {
    ...raw,
    properties: { ...raw.properties, parameter: narrow(raw.properties.parameter) },
    ...(raw.parameters && typeof raw.parameters === 'object'
      ? { parameters: narrow(raw.parameters) }
      : {}),
  };
}
beforeEach(async () => {
  fixture = await nativeFixture();
  raw = await readFixture('tilted-wide.json');
  vi.useFakeTimers();
  source = initPowerService({
    config: { dataframeDropEnabled: true, maxCanvasesPerProcess: 8 },
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/parameters'))
        return Response.json(
          Object.fromEntries(
            [...parameters, ...wideCodes, ...monthlyArgs.selection.parameters].map((code) => [
              code,
              {},
            ]),
          ),
        );
      if (url.pathname.endsWith('/configuration')) return Response.json({});
      if (url.pathname.endsWith('/climatology/point') || url.pathname.endsWith('/monthly/point'))
        return Response.json(requested(url));
      throw new Error(`Unexpected replay URL: ${url}`);
    },
  });
});
afterEach(async () => {
  source.dispose();
  vi.useRealTimers();
  await fixture.close();
});

it('characterizes successful complete wide climatology with corrected expansions', async () => {
  const result = await settle(run());
  expect(result.isError).not.toBe(true);
  const output = PointOutputSchema.parse(result.structuredContent);
  expect(output.rowCount).toBe(13);
  expect(output.dataset?.rowCount).toBe(13);
  expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(40000);
  expect(text(result).length).toBeLessThanOrEqual(40000);
  /** A no-row envelope that fits keeps every summary inline and gains no summary handle. */
  expect(Object.keys(result.structuredContent as object)).toEqual([
    'request',
    'metadata',
    'parameters',
    'expansions',
    'omittedParameters',
    'summaries',
    'rows',
    'rowCount',
    'dataset',
  ]);
  /** 33 numeric columns with two period kinds each; the three orientation columns have none. */
  expect(output.summaries).toHaveLength(66);
  expect(text(result)).toBe(formatFaithfully(result.structuredContent as object)[0]?.text);
  const handle = output.dataset!;
  const rows = [];
  for (const offset of [0, 5, 10, 13]) {
    const page = await fixture.service.query(
      handle.canvas_id,
      { sql: `SELECT * FROM ${handle.table} ORDER BY month NULLS LAST LIMIT 5 OFFSET ${offset}` },
      fixture.ctx,
    );
    rows.push(...page.rows);
    if (offset === 13) expect(page.rows).toEqual([]);
  }
  expect(rows).toHaveLength(13);
  expect(rows.at(-1)).toMatchObject({
    periodKey: 'ANN',
    periodKind: 'climatology_annual',
    month: null,
  });
  for (const row of rows)
    for (const [code, series] of Object.entries(raw.properties.parameter))
      expect(row[code]).toBe(
        series[String(row.periodKey)] === -999 ? null : series[String(row.periodKey)],
      );
});

it('reuses the explicit token and exposes recovery for unknown and wrong-tenant tokens', async () => {
  const first = PointOutputSchema.parse((await settle(run())).structuredContent).dataset!;
  const reused = await run({ canvas_id: first.canvas_id });
  expect(reused.isError).not.toBe(true);
  const second = PointOutputSchema.parse(reused.structuredContent).dataset!;
  expect(second.canvas_id).toBe(first.canvas_id);
  expect(second.table).not.toBe(first.table);
  expect(await fixture.provider.describe(first.canvas_id, fixture.ctx)).toHaveLength(2);
  for (const [canvas_id, ctx] of [
    ['abcdefghij', {}],
    [first.canvas_id, { tenantId: 'other' }],
  ] as const) {
    const failed = await run({ canvas_id }, ctx);
    expect(failed.structuredContent).toMatchObject({
      error: { data: { reason: 'canvas_not_found', recovery: { hint: expect.any(String) } } },
    });
    expect(text(failed)).toContain('canvas_not_found');
    expect(text(failed)).toContain('canvas_id');
  }
  fixture.advance(21_600_001);
  await fixture.registry.sweep();
  const expired = await run({ canvas_id: first.canvas_id });
  expect(expired.structuredContent).toMatchObject({
    error: { data: { reason: 'canvas_not_found' } },
  });
  expect(text(expired)).toContain('canvas_not_found');
});

it('reports canvas_required with narrowing guidance on both surfaces when native staging is disabled', async () => {
  const disabled = withoutWorkspace();
  try {
    const result = await settle(run());
    const data = (
      result.structuredContent as {
        error: { data: { rowCount: number; inlineRows: number; recovery: { hint: string } } };
      }
    ).error.data;
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'canvas_required', rowCount: 13, calls: expect.any(Array) } },
    });
    expect(data.recovery.hint).toContain(
      `The complete result has 13 rows and at most ${data.inlineRows} fit inline in one call.`,
    );
    expect(text(result)).toContain('canvas_required');
    expect(text(result)).toContain('rowCount: 13');
    expect(text(result)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  } finally {
    await disabled.shutdown();
  }
});

it('splits a wide climatology into parameter groups that each re-send inline and together cover every column', async () => {
  const disabled = withoutWorkspace();
  try {
    const split = sizedRefusal(await settle(run()), 13);
    expect(split.inlineRows).toBe(13);
    const calls = split.calls as { selection: { mode: string; parameters: string[] } }[];
    for (const call of calls) {
      expect(Object.keys(call)).toEqual(['selection']);
      expect(call.selection.mode).toBe('parameters');
    }
    expect(calls.flatMap((call) => call.selection.parameters).sort()).toEqual(
      [...parameters].sort(),
    );
    const columns = new Set<string>();
    for (const call of calls) {
      const result = await settle(run(call));
      expect(result.isError).not.toBe(true);
      const output = PointOutputSchema.parse(result.structuredContent);
      expect(output).toMatchObject({ rowCount: 13, dataset: null });
      for (const row of output.rows)
        for (const key of Object.keys(row)) if (key in raw.properties.parameter) columns.add(key);
    }
    expect([...columns].sort()).toEqual(Object.keys(raw.properties.parameter).sort());
  } finally {
    await disabled.shutdown();
  }
});

it('stages every summary of a wide hour-group climatology as a related table beside its observations', async () => {
  raw = await readWide();
  const expected = wideSummaries();
  expect(expected).toHaveLength(116);
  const register = vi.spyOn(fixture.provider, 'registerTable');
  const result = await settle(run(wideArgs));
  expect(result.isError).not.toBe(true);
  const output = PointOutputSchema.parse(result.structuredContent);
  expect(text(result)).toBe(formatFaithfully(result.structuredContent as object)[0]?.text);
  expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(40000);
  expect(text(result).length).toBeLessThanOrEqual(40000);
  expect(output.summaries).toEqual(expected.slice(0, 1));
  expect(output.summaryCount).toBe(116);
  expect(output.rowCount).toBe(13);
  const observations = output.dataset!;
  const summary = output.summaryDataset!;
  expect(observations.rowCount).toBe(13);
  expect(summary).toMatchObject({
    canvas_id: observations.canvas_id,
    rowCount: 116,
    describeTool: 'nasa_power_dataframe_describe',
    queryTool: 'nasa_power_dataframe_query',
  });
  expect(register).toHaveBeenCalledTimes(2);
  for (const value of [summary.table, observations.table]) expect(text(result)).toContain(value);
  const restored = [];
  for (let offset = 0; offset <= 120; offset += 40) {
    const page = await fixture.service.query(
      summary.canvas_id,
      { sql: `SELECT * FROM ${summary.table} ORDER BY summaryIndex LIMIT 40 OFFSET ${offset}` },
      fixture.ctx,
    );
    if (offset >= 116) expect(page.rows).toEqual([]);
    /** SQL NULL units restore an omitted source unit. */
    restored.push(
      ...page.rows.map(({ summaryIndex: _i, ...row }) =>
        row.units === null
          ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'units'))
          : row,
      ),
    );
  }
  expect(restored).toEqual(expected);
  const rows = (
    await fixture.service.query(
      observations.canvas_id,
      { sql: `SELECT * FROM ${observations.table} ORDER BY month NULLS LAST` },
      fixture.ctx,
    )
  ).rows;
  expect(rows).toHaveLength(13);
  for (const row of rows)
    for (const [code, series] of Object.entries(raw.properties.parameter))
      expect(row[code]).toBe(
        series[String(row.periodKey)] === -999 ? null : series[String(row.periodKey)],
      );
  for (const handle of [observations, summary]) {
    const described = await fixture.service.describe(
      handle.canvas_id,
      { table: handle.table },
      fixture.ctx,
    );
    expect(JSON.stringify(described).length).toBeLessThanOrEqual(40000);
    expect(formatFaithfully(described)[0]?.text.length).toBeLessThanOrEqual(40000);
    expect(described.tables[0]?.provenance.envelope).toMatchObject({
      summaryCount: 116,
      summaries: expected.slice(0, 1),
      dataset: { table: observations.table },
      summaryDataset: { table: summary.table },
    });
  }
});

it('stages every summary of a wide monthly timeseries as a related table beside its observations', async () => {
  raw = await readFixture('hour-wide-monthly.json');
  const complete = normalized(monthlyArgs);
  expect(complete.parameters).toHaveLength(59);
  expect(complete.summaries).toHaveLength(118);
  const result = await settle(runToolContract(getTimeseriesTool, monthlyArgs));
  expect(result.isError).not.toBe(true);
  const output = PointOutputSchema.parse(result.structuredContent);
  const observations = output.dataset!;
  const summary = output.summaryDataset!;
  const { rows: _rows, summaries: _summaries, ...envelope } = complete;
  const handle = (table: string, rowCount: number) => ({
    canvas_id: observations.canvas_id,
    table,
    rowCount,
    expiresAt: observations.expiresAt,
    columns: expect.any(Array),
    describeTool: 'nasa_power_dataframe_describe',
    queryTool: 'nasa_power_dataframe_query',
  });
  expect(output.rows.length).toBeGreaterThan(0);
  expect(result.structuredContent).toEqual({
    ...envelope,
    metadata: {
      ...complete.metadata,
      endpointUrl: expect.stringMatching(
        /^https:\/\/power\.larc\.nasa\.gov\/api\/temporal\/monthly\/point\?/,
      ),
      fetchedAt: expect.any(String),
    },
    summaries: complete.summaries.slice(0, 1),
    summaryCount: 118,
    rows: complete.rows.slice(0, output.rows.length),
    rowCount: 13,
    dataset: handle(expect.stringMatching(/^power_[0-9a-f]{32}$/), 13),
    summaryDataset: handle(expect.stringMatching(/^power_[0-9a-f]{32}$/), 118),
  });
  expect(summary.table).not.toBe(observations.table);
  expect(text(result)).toBe(formatFaithfully(result.structuredContent as object)[0]?.text);
  expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(40000);
  expect(text(result).length).toBeLessThanOrEqual(40000);
  const restored = [];
  for (let offset = 0; offset <= 120; offset += 40) {
    const page = await fixture.service.query(
      summary.canvas_id,
      { sql: `SELECT * FROM ${summary.table} ORDER BY summaryIndex LIMIT 40 OFFSET ${offset}` },
      fixture.ctx,
    );
    if (offset >= 118) expect(page.rows).toEqual([]);
    /** SQL NULL units restore an omitted source unit. */
    restored.push(
      ...page.rows.map(({ summaryIndex: _i, ...row }) =>
        row.units === null
          ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'units'))
          : row,
      ),
    );
  }
  expect(restored).toEqual(complete.summaries);
  const stored = await fixture.service.query(
    observations.canvas_id,
    { sql: `SELECT * FROM ${observations.table} ORDER BY periodKey` },
    fixture.ctx,
  );
  expect(stored.rows).toEqual(complete.rows);
});

it('refuses a wide hour-group climatology without a workspace with parameter groups that re-send inline and cover every column and summary', async () => {
  raw = await readWide();
  const expected = wideSummaries();
  const disabled = withoutWorkspace();
  try {
    const split = sizedRefusal(await settle(run(wideArgs)), 13);
    expect(split.inlineRows).toBe(13);
    expect(split.calls).toEqual([
      { selection: { mode: 'parameters', parameters: ['ALLSKY_SFC_SW_DWN_HR'] } },
      {
        selection: {
          mode: 'parameters',
          parameters: ['ALLSKY_SFC_SW_DIFF_HR', 'SI_TRACKER_AVG', 'T2M', 'RH2M', 'WS10M', 'PS'],
        },
      },
      { selection: { mode: 'parameters', parameters: ['PRECTOTCORR'] } },
    ]);
    const columns: string[] = [];
    const summaries: unknown[] = [];
    for (const call of split.calls) {
      const result = await settle(run({ ...wideArgs, ...call }));
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(40000);
      expect(text(result).length).toBeLessThanOrEqual(40000);
      expect(Object.keys(result.structuredContent as object)).not.toContain('summaryCount');
      const output = PointOutputSchema.parse(result.structuredContent);
      expect(output).toMatchObject({ rowCount: 13, dataset: null });
      expect(output.rows).toHaveLength(13);
      columns.push(...output.parameters.map((parameter) => parameter.code));
      summaries.push(...output.summaries);
    }
    expect(columns.sort()).toEqual(Object.keys(raw.properties.parameter).sort());
    expect(columns).toHaveLength(58);
    const order = (items: unknown[]) =>
      (items as { parameter: string; periodKind: string }[]).toSorted((a, b) =>
        `${a.parameter} ${a.periodKind}`.localeCompare(`${b.parameter} ${b.periodKind}`),
      );
    expect(order(summaries)).toEqual(order(expected));
  } finally {
    await disabled.shutdown();
  }
});

it.each([true, false])(
  'keeps dataset_limit when a wide profile still overflows with one inline summary (workspace %s)',
  async (enabled) => {
    raw = await readWide();
    raw.parameters = { T2M: { units: 'C', longname: 'x'.repeat(40001) } };
    const expected = wideSummaries();
    const disabled = enabled ? undefined : withoutWorkspace();
    /** The serving service in either branch; its single present call is the compact envelope. */
    const present = vi.spyOn(disabled ?? fixture.service, 'present');
    const acquire = vi.spyOn(fixture.canvas, 'acquire');
    try {
      const result = await settle(run(wideArgs));
      expect(result.structuredContent).toMatchObject({
        error: {
          message: 'Scientific metadata exceeds the complete response budget.',
          data: { reason: 'dataset_limit' },
        },
      });
      expect(text(result)).toContain('dataset_limit');
      expect(present).toHaveBeenCalledOnce();
      const [compact, , , , , related] = present.mock.calls[0]!;
      expect(compact).toMatchObject({ summaries: expected.slice(0, 1), summaryCount: 116 });
      expect(related?.map((table) => [table.key, table.rows.length])).toEqual([['summaries', 116]]);
      if (enabled) expect(acquire).not.toHaveBeenCalled();
    } finally {
      await disabled?.shutdown();
    }
  },
);

it('rejects metadata overflow before native registration and malformed canvas input before fetch', async () => {
  raw = { ...raw, parameters: { T2M: { longname: 'x'.repeat(40001) } } };
  const acquire = vi.spyOn(fixture.canvas, 'acquire');
  const result = await settle(run());
  expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'dataset_limit' } } });
  expect(text(result)).toContain('dataset_limit');
  expect(acquire).not.toHaveBeenCalled();
  const malformed = await run({ canvas_id: 'bad' });
  expect(malformed.isError).toBe(true);
  expect(text(malformed)).toContain('canvas_id');
});
