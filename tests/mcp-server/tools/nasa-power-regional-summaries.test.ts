/** @fileoverview Captured annual regional observations and reconstructable summary tables. @module tests/mcp-server/tools/nasa-power-regional-summaries */
import { readFile } from 'node:fs/promises';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRegionTool } from '@/mcp-server/tools/definitions/nasa-power-get-region.tool.js';
import { formatFaithfully } from '@/services/canvas/format.js';
import { initCanvasService } from '@/services/canvas/index.js';
import { initPowerService } from '@/services/power/index.js';
import { normalizeRegion, RegionPayloadSchema } from '@/services/power/normalize.js';
import { CellSummarySchema, RegionRequestSchema } from '@/services/power/types.js';
import { dataset, nativeFixture } from '../../services/canvas/fixture.js';

const args = {
  latitudeMin: 46,
  latitudeMax: 48,
  longitudeMin: -123,
  longitudeMax: -121,
  parameter: 'PRECTOTCORR',
  community: 'AG' as const,
  temporalResolution: 'daily' as const,
  startDate: '2024-01-01',
  endDate: '2024-12-31',
};
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let source: ReturnType<typeof initPowerService>;
let raw: ReturnType<typeof RegionPayloadSchema.parse>;
let expected: ReturnType<typeof CellSummarySchema.parse>[];
const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
const run = (extra = {}) => runToolContract(getRegionTool, { ...args, ...extra });
async function settle<T>(result: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(6000);
  return result;
}
function normalized() {
  return normalizeRegion(raw, RegionRequestSchema.parse(args), {
    endpointUrl: 'https://power.larc.nasa.gov/api/temporal/daily/regional',
    fetchedAt: '2026-10-24T00:00:00Z',
    cacheHit: false,
  });
}
beforeEach(async () => {
  fixture = await nativeFixture();
  raw = RegionPayloadSchema.parse(
    JSON.parse(
      await readFile(new URL('../../fixtures/region-annual.json', import.meta.url), 'utf8'),
    ),
  );
  expected = CellSummarySchema.array().parse(
    JSON.parse(
      await readFile(
        new URL('../../fixtures/region-annual-summaries.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  vi.useFakeTimers();
  source = initPowerService({
    config: { dataframeDropEnabled: true, maxCanvasesPerProcess: 8 },
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/parameters')) return Response.json({ PRECTOTCORR: {} });
      if (url.pathname.endsWith('/configuration')) return Response.json({});
      if (url.pathname.endsWith('/daily/regional')) return Response.json(raw);
      throw new Error(`Unexpected replay URL: ${url}`);
    },
  });
});
afterEach(async () => {
  source.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fixture.close();
});

it('characterizes inline-sized and empty regional envelopes without native acquisition', async () => {
  for (const feature of raw.features)
    feature.properties.parameter.PRECTOTCORR = Object.fromEntries(
      Object.entries(feature.properties.parameter.PRECTOTCORR!).filter(
        ([key]) => key <= '20240102',
      ),
    );
  const result = await settle(run({ endDate: '2024-01-02' }));
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    rowCount: 30,
    dataset: null,
    summaries: expected.slice(0, 2),
  });
  expect(text(result)).toContain('PRECTOTCORR');
  const empty = normalized();
  empty.rows = [];
  empty.summaries = [];
  expect(
    await fixture.service.present(empty, undefined, fixture.ctx, 'nasa_power_get_region'),
  ).toMatchObject({ rowCount: 0, dataset: null, summaries: [] });
  expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
});

it('stages all annual observations and ordered exact summaries through both tool surfaces', async () => {
  expect(normalized().summaries).toEqual(expected);
  const result = await settle(run());
  expect(result.isError).not.toBe(true);
  const output = getRegionTool.output.parse(result.structuredContent);
  expect(output.rowCount).toBe(5490);
  expect(output.summaryCount).toBe(366);
  expect(output.summaries).toEqual(expected.slice(0, output.summaries.length));
  expect(output.summaries.length).toBeLessThan(366);
  const summary = output.summaryDataset!;
  expect(summary.rowCount).toBe(366);
  expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(40000);
  expect(text(result).length).toBeLessThanOrEqual(40000);
  for (const value of [summary.table, summary.canvas_id, 'summaryCount', '366'])
    expect(text(result)).toContain(value);
  const restored = [];
  for (let offset = 0; offset <= 400; offset += 40) {
    const page = await fixture.service.query(
      summary.canvas_id,
      { sql: `SELECT * FROM ${summary.table} ORDER BY summaryIndex LIMIT 40 OFFSET ${offset}` },
      fixture.ctx,
    );
    restored.push(...page.rows.map(({ summaryIndex: _i, ...row }) => row));
    if (offset > 366) expect(page.rows).toEqual([]);
  }
  expect(restored).toEqual(expected);
  const observations = output.dataset!;
  const sourceValues = new Map(
    raw.features.flatMap((feature) =>
      Object.entries(feature.properties.parameter.PRECTOTCORR!).map(([key, value]) => [
        `${feature.geometry.coordinates[0]},${feature.geometry.coordinates[1]},${key}`,
        value,
      ]),
    ),
  );
  let count = 0;
  for (let offset = 0; offset < 5600; offset += 100) {
    const page = await fixture.service.query(
      observations.canvas_id,
      {
        sql: `SELECT longitude, latitude, periodKey, PRECTOTCORR FROM ${observations.table} ORDER BY cellId, periodKey LIMIT 100 OFFSET ${offset}`,
      },
      fixture.ctx,
    );
    for (const row of page.rows) {
      const value = sourceValues.get(`${row.longitude},${row.latitude},${row.periodKey}`);
      expect(row.PRECTOTCORR).toBe(value === -999 ? null : value);
      count++;
    }
  }
  expect(count).toBe(5490);
  for (const handle of [observations, summary]) {
    const described = await fixture.service.describe(
      handle.canvas_id,
      { table: handle.table },
      fixture.ctx,
    );
    expect(JSON.stringify(described).length).toBeLessThanOrEqual(40000);
    expect(
      formatFaithfully(described).reduce((sum, block) => sum + block.text.length, 0),
    ).toBeLessThanOrEqual(40000);
    expect(described.tables[0]?.provenance.envelope).toMatchObject({
      summaryCount: 366,
      summaryDataset: { table: summary.table },
    });
  }
  const second = await run({ canvas_id: observations.canvas_id });
  expect(second.isError).not.toBe(true);
  expect(getRegionTool.output.parse(second.structuredContent).dataset?.canvas_id).toBe(
    observations.canvas_id,
  );
});

it.each(['registration', 'provenance'] as const)(
  'rolls back the complete regional batch after a later %s failure and preserves prior tables',
  async (boundary) => {
    const existing = (
      await fixture.service.present(dataset(), undefined, fixture.ctx, 'nasa_power_get_timeseries')
    ).dataset!;
    let count = 0;
    if (boundary === 'registration') {
      const register = fixture.provider.registerTable.bind(fixture.provider);
      vi.spyOn(fixture.provider, 'registerTable').mockImplementation(async (...input) => {
        if (++count === 2) throw new Error('regional registration failure');
        return register(...input);
      });
    } else {
      const write = fixture.storage.set.bind(fixture.storage);
      vi.spyOn(fixture.storage, 'set').mockImplementation(async (...input) => {
        await write(...input);
        if (++count === 2) throw new Error('regional provenance failure');
      });
    }
    await expect(
      fixture.service.presentRegion(
        normalized(),
        existing.canvas_id,
        fixture.ctx,
        'nasa_power_get_region',
      ),
    ).rejects.toThrow(`regional ${boundary} failure`);
    expect(
      (await fixture.provider.describe(existing.canvas_id, fixture.ctx)).map((table) => table.name),
    ).toEqual([existing.table]);
    expect((await fixture.storage.list('power/canvas/', fixture.ctx)).keys).toHaveLength(1);
    vi.restoreAllMocks();
    const retried = await fixture.service.presentRegion(
      normalized(),
      existing.canvas_id,
      fixture.ctx,
      'nasa_power_get_region',
    );
    expect(retried.dataset?.canvas_id).toBe(existing.canvas_id);
    expect(await fixture.provider.describe(existing.canvas_id, fixture.ctx)).toHaveLength(3);
  },
);

it('counts both tables against admission without evicting existing tables', async () => {
  const first = (
    await fixture.service.present(dataset(), undefined, fixture.ctx, 'nasa_power_get_timeseries')
  ).dataset!;
  for (let i = 1; i < 7; i++)
    await fixture.service.present(
      dataset(),
      first.canvas_id,
      fixture.ctx,
      'nasa_power_get_timeseries',
    );
  const register = vi.spyOn(fixture.provider, 'registerTable');
  await expect(
    fixture.service.presentRegion(
      normalized(),
      first.canvas_id,
      fixture.ctx,
      'nasa_power_get_region',
    ),
  ).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
  expect(register).not.toHaveBeenCalled();
  expect(await fixture.provider.describe(first.canvas_id, fixture.ctx)).toHaveLength(7);
});

it('retains exact all-missing summaries and omitted units through SQL', async () => {
  const input = normalized();
  delete input.summaries[1]!.units;
  Object.assign(input.summaries[1]!, {
    validCellCount: 0,
    missingCellCount: 15,
    min: null,
    mean: null,
    max: null,
  });
  const output = await fixture.service.presentRegion(
    input,
    undefined,
    fixture.ctx,
    'nasa_power_get_region',
  );
  const handle = output.summaryDataset!;
  const page = await fixture.service.query(
    handle.canvas_id,
    { sql: `SELECT * FROM ${handle.table} WHERE summaryIndex = 1` },
    fixture.ctx,
  );
  expect(page.rows).toEqual([{ ...input.summaries[1], units: null, summaryIndex: 1 }]);
});

it('returns actionable canvas_required for an annual region with native staging disabled', async () => {
  const disabled = initCanvasService({
    storage: fixture.storage,
    config: { dataframeDropEnabled: false, maxCanvasesPerProcess: 8 },
  });
  try {
    const result = await settle(run());
    const data = (
      result.structuredContent as {
        error: { data: { rowCount: number; inlineRows: number; recovery: { hint: string } } };
      }
    ).error.data;
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'canvas_required', calls: expect.any(Array) } },
    });
    expect(data.rowCount).toBeGreaterThan(data.inlineRows);
    expect(data.recovery.hint).toContain(
      `The complete result has ${data.rowCount} rows and at most ${data.inlineRows} fit inline in one call.`,
    );
    expect(text(result)).toContain('canvas_required');
    expect(text(result)).toContain(`rowCount: ${data.rowCount}`);
    expect(text(result)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  } finally {
    await disabled.shutdown();
  }
});

it('includes summary bytes in the complete batch budget before native admission', async () => {
  const input = normalized();
  input.summaries = Array.from({ length: 200000 }, () => input.summaries[0]!);
  expect(
    Buffer.byteLength(JSON.stringify(input.summaries)) +
      Buffer.byteLength(JSON.stringify(input.rows)),
  ).toBeGreaterThan(32 * 1024 * 1024);
  const acquire = vi.spyOn(fixture.canvas, 'acquire');
  await expect(
    fixture.service.presentRegion(input, undefined, fixture.ctx, 'nasa_power_get_region'),
  ).rejects.toMatchObject({ data: { reason: 'dataset_limit' } });
  expect(acquire).not.toHaveBeenCalled();
});
