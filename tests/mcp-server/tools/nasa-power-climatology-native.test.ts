/** @fileoverview Captured climatology retrieval and explicit native token reuse. @module tests/mcp-server/tools/nasa-power-climatology-native */
import { readFile } from 'node:fs/promises';
import { type MockContextOptions, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getClimatologyTool } from '@/mcp-server/tools/definitions/nasa-power-get-climatology.tool.js';
import { PointOutputSchema } from '@/mcp-server/tools/definitions/point-contracts.js';
import { initCanvasService } from '@/services/canvas/index.js';
import { initPowerService } from '@/services/power/index.js';
import { nativeFixture } from '../../services/canvas/fixture.js';

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
async function settle<T>(result: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(6000);
  return result;
}
beforeEach(async () => {
  fixture = await nativeFixture();
  raw = JSON.parse(
    await readFile(new URL('../../fixtures/tilted-wide.json', import.meta.url), 'utf8'),
  );
  vi.useFakeTimers();
  source = initPowerService({
    config: { dataframeDropEnabled: true, maxCanvasesPerProcess: 8 },
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/parameters'))
        return Response.json(Object.fromEntries(parameters.map((code) => [code, {}])));
      if (url.pathname.endsWith('/configuration')) return Response.json({});
      if (url.pathname.endsWith('/climatology/point')) return Response.json(raw);
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
  const disabled = initCanvasService({
    storage: fixture.storage,
    config: { dataframeDropEnabled: false, maxCanvasesPerProcess: 8 },
  });
  try {
    const result = await settle(run());
    expect(result.structuredContent).toMatchObject({
      error: {
        data: { reason: 'canvas_required', recovery: { hint: expect.stringContaining('Narrow') } },
      },
    });
    expect(text(result)).toContain('canvas_required');
    expect(text(result)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(text(result)).toContain('Narrow');
  } finally {
    await disabled.shutdown();
  }
});

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
