/** @fileoverview Native staging of complete geographic data and provenance. @module tests/mcp-server/tools/nasa-power-geographic-native */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { expect, it, vi } from 'vitest';
import { getRegionTool } from '@/mcp-server/tools/definitions/nasa-power-get-region.tool.js';
import { initPowerService } from '@/services/power/index.js';
import { nativeFixture } from '../../services/canvas/fixture.js';

it('stages every native-grid row while preserving typed cell identity and complete provenance', async () => {
  const fixture = await nativeFixture();
  const features = Array.from({ length: 400 }, (_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-120 + (i % 20) / 10, 40 + Math.floor(i / 20) / 10] },
    properties: { parameter: { T2M: { '20240101': i < 200 ? -999 : i + 0.125 } } },
  }));
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/parameters')) return Response.json({ T2M: {} });
    if (url.pathname.endsWith('/configuration')) return Response.json({});
    return Response.json({
      type: 'FeatureCollection',
      features,
      header: { fill_value: -999, sources: ['https://example.com/grid'] },
      parameters: { T2M: { units: 'C' } },
    });
  });
  const source = initPowerService({ fetch: fetcher, config: { dataframeDropEnabled: true } });
  try {
    const ctx = {
      ...createMockContext({ errors: getRegionTool.errors }),
      state: fixture.ctx.state,
    };
    const output = await getRegionTool.handler(
      getRegionTool.input.parse({
        temporalResolution: 'daily',
        latitudeMin: 40,
        latitudeMax: 42,
        longitudeMin: -120,
        longitudeMax: -118,
        startDate: '2024-01-01',
        endDate: '2024-01-01',
        parameter: 'T2M',
      }),
      ctx,
    );
    expect(getRegionTool.output!.parse(output)).toEqual(output);
    const data = output as {
      rows: unknown[];
      dataset: { canvas_id: string; table: string; rowCount: number };
      rowCount: number;
    };
    expect(data.rowCount).toBe(400);
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows.length).toBeLessThan(400);
    expect(data.dataset.rowCount).toBe(400);
    const rendered = getRegionTool.format!(output)
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    for (const value of [
      data.dataset.canvas_id,
      data.dataset.table,
      'nasa_power_dataframe_query',
      'cellId',
    ])
      expect(rendered).toContain(value);
    const queried = await fixture.service.query(
      data.dataset.canvas_id,
      {
        sql: `SELECT CAST(COUNT(*) AS INTEGER) AS n, CAST(COUNT(T2M) AS INTEGER) AS valid, MAX(T2M) AS max FROM ${data.dataset.table}`,
      },
      fixture.ctx,
    );
    expect(queried.rows).toEqual([{ n: 400, valid: 200, max: 399.125 }]);
    const tail = await fixture.service.query(
      data.dataset.canvas_id,
      { sql: `SELECT cellId, T2M FROM ${data.dataset.table} ORDER BY T2M DESC NULLS LAST LIMIT 1` },
      fixture.ctx,
    );
    expect(tail.rows).toEqual([{ cellId: 'cell_400', T2M: 399.125 }]);
    const described = await fixture.service.describe(data.dataset.canvas_id, {}, fixture.ctx);
    expect(described.tables[0]).toMatchObject({
      rowCount: 400,
      columns: expect.arrayContaining([
        expect.objectContaining({ name: 'cellId', type: 'VARCHAR', nullable: false }),
        expect.objectContaining({ name: 'T2M', type: 'DOUBLE', units: 'C' }),
      ]),
      provenance: {
        sourceTool: 'nasa_power_get_region',
        envelope: { cellCount: 400, metadata: { sources: ['https://example.com/grid'] } },
      },
    });
  } finally {
    source.dispose();
    await fixture.close();
  }
}, 15_000);
