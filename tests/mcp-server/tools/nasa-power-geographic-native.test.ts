/** @fileoverview Native staging of complete geographic data and provenance. @module tests/mcp-server/tools/nasa-power-geographic-native */

import { readFile } from 'node:fs/promises';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, it, vi } from 'vitest';
import { ComparisonOutputSchema } from '@/mcp-server/tools/definitions/comparison-contracts.js';
import { compareLocationsTool } from '@/mcp-server/tools/definitions/nasa-power-compare-locations.tool.js';
import { getRegionTool } from '@/mcp-server/tools/definitions/nasa-power-get-region.tool.js';
import { PointOutputSchema } from '@/mcp-server/tools/definitions/point-contracts.js';
import { formatFaithfully } from '@/services/canvas/format.js';
import { initPowerService, PowerDatasetSchema } from '@/services/power/index.js';
import {
  normalizePoint,
  normalizeRegion,
  PointPayloadSchema,
  RegionPayloadSchema,
} from '@/services/power/normalize.js';
import { PowerRequestSchema } from '@/services/power/types.js';
import { nativeFixture } from '../../services/canvas/fixture.js';

it.each(['T_ZONES', 'TM_ZONES'])(
  'round-trips %s numeric codes, fills and absent keys through native SQL',
  async (code) => {
    const fixture = await nativeFixture();
    try {
      const periods = Array.from({ length: 400 }, (_, i) =>
        new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10).replaceAll('-', ''),
      );
      const values = Object.fromEntries(
        periods
          .slice(1)
          .map((key, i) => [key, i < 100 ? -999 : i === 100 ? 0 : i === 101 ? 22 : 61]),
      );
      const captured = PointPayloadSchema.parse({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-122, 47] },
        properties: {
          parameter: { [code]: values, T2M: Object.fromEntries(periods.map((key) => [key, 1])) },
        },
        header: { fill_value: -999 },
        parameters: { [code]: { units: 'zones' }, T2M: { units: 'C' } },
      });
      const request = PowerRequestSchema.parse({
        temporalResolution: 'daily',
        latitude: 47,
        longitude: -122,
        startDate: '2024-01-01',
        endDate: '2025-02-03',
        selection: { mode: 'parameters', parameters: [code, 'T2M'] },
      });
      const normalized = normalizePoint(captured, request, {
        endpointUrl: 'https://power.larc.nasa.gov/api/temporal/daily/point',
        fetchedAt: '2026-10-24T00:00:00Z',
        cacheHit: false,
      });
      const output = PointOutputSchema.parse(
        await fixture.service.present(
          normalized,
          undefined,
          fixture.ctx,
          'nasa_power_get_timeseries',
        ),
      );
      const handle = output.dataset!;
      expect(handle.columns).toContainEqual(
        expect.objectContaining({ name: code, type: 'DOUBLE', valueKind: 'categorical' }),
      );
      const queried = await fixture.service.query(
        handle.canvas_id,
        {
          sql: `SELECT periodKey, ${code} FROM ${handle.table} ORDER BY periodKey`,
          rowLimit: 1000,
        },
        fixture.ctx,
      );
      expect(queried.rows).toEqual(
        periods.map((periodKey) => ({
          periodKey,
          [code]:
            values[periodKey] === -999 || values[periodKey] === undefined
              ? null
              : values[periodKey],
        })),
      );
      expect(output.summaries.map((summary) => summary.parameter)).toEqual(['T2M']);
    } finally {
      await fixture.close();
    }
  },
);

it('preserves distinct tilted group expansions and orientation in staged-table provenance', async () => {
  const fixture = await nativeFixture();
  try {
    const captured = PointPayloadSchema.parse(
      JSON.parse(
        await readFile(new URL('../../fixtures/tilted-wide.json', import.meta.url), 'utf8'),
      ),
    );
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
    const request = PowerRequestSchema.parse({
      temporalResolution: 'climatology',
      latitude: 47.6,
      longitude: -122.3,
      selection: { mode: 'parameters', parameters },
    });
    const normalized = normalizePoint(captured, request, {
      endpointUrl: 'https://power.larc.nasa.gov/api/temporal/climatology/point',
      fetchedAt: '2026-10-24T00:00:00Z',
      cacheHit: false,
    });
    const output = PointOutputSchema.parse(
      await fixture.service.present(
        normalized,
        undefined,
        fixture.ctx,
        'nasa_power_get_climatology',
      ),
    );
    expect(output.rowCount).toBe(13);
    expect(output.omittedParameters).toEqual([]);
    const handle = output.dataset!;
    expect(handle.rowCount).toBe(13);
    for (const alias of ['SI_TILTED_AVG', 'SI_TILTED_MIN', 'SI_TILTED_MAX']) {
      expect(output.expansions[alias]).toHaveLength(8);
      expect(output.expansions[alias]?.every((code) => code.startsWith(`${alias}_`))).toBe(true);
    }
    expect(
      formatFaithfully(output)
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n'),
    ).toContain('SI_TILTED_MIN_OPTIMAL_ANG_ORT');
    const described = await fixture.service.describe(handle.canvas_id, {}, fixture.ctx);
    expect(described.tables[0]?.provenance.envelope).toMatchObject({
      expansions: output.expansions,
      omittedParameters: [],
      metadata: { messages: captured.messages },
    });
    const queried = await fixture.service.query(
      handle.canvas_id,
      {
        sql: `SELECT periodKey, SI_TILTED_AVG_OPTIMAL_ANG_ORT, SI_TILTED_MIN_OPTIMAL_ANG_ORT, SI_TILTED_MAX_OPTIMAL_ANG_ORT FROM ${handle.table} WHERE periodKey = 'ANN'`,
      },
      fixture.ctx,
    );
    expect(queried.rows).toEqual([
      {
        periodKey: 'ANN',
        SI_TILTED_AVG_OPTIMAL_ANG_ORT: 'S',
        SI_TILTED_MIN_OPTIMAL_ANG_ORT: 'S',
        SI_TILTED_MAX_OPTIMAL_ANG_ORT: 'S',
      },
    ]);
  } finally {
    await fixture.close();
  }
});

it('replays climate-zone source codes through both surfaces and numeric SQL with categorical provenance', async () => {
  const fixture = await nativeFixture();
  const captured = JSON.parse(
    await readFile(new URL('../../fixtures/climate-zones.json', import.meta.url), 'utf8'),
  );
  try {
    const request = getRegionTool.input.parse({
      temporalResolution: 'climatology',
      community: 'SB',
      latitudeMin: 35,
      latitudeMax: 37,
      longitudeMin: -120,
      longitudeMax: -118,
      parameter: 'TM_ZONES',
    });
    const normalized = normalizeRegion(RegionPayloadSchema.parse(captured), request, {
      endpointUrl: 'https://power.larc.nasa.gov/api/temporal/climatology/regional',
      fetchedAt: '2026-10-24T00:00:00Z',
      cacheHit: false,
    });
    const output = getRegionTool.output!.parse(
      await fixture.service.present(normalized, undefined, fixture.ctx, 'nasa_power_get_region'),
    );
    expect(output.rowCount).toBe(260);
    expect(output.summaries).toEqual([]);
    expect(output.parameters).toEqual([
      expect.objectContaining({ code: 'TM_ZONES', valueKind: 'categorical' }),
    ]);
    const handle = output.dataset!;
    expect(handle.columns).toContainEqual(
      expect.objectContaining({ name: 'TM_ZONES', type: 'DOUBLE', valueKind: 'categorical' }),
    );
    expect(
      getRegionTool.format!(output)
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n'),
    ).toContain('categorical');
    const rows = await fixture.service.query(
      handle.canvas_id,
      { sql: `SELECT TM_ZONES FROM ${handle.table} WHERE periodKey = 'ANN' ORDER BY cellId` },
      fixture.ctx,
    );
    expect(rows.rows.map((row) => row.TM_ZONES).sort((a, b) => Number(a) - Number(b))).toEqual([
      22, 22, 22, 22, 31, 31, 32, 32, 32, 32, 32, 32, 32, 32, 32, 41, 42, 51, 53, 61,
    ]);
    const described = await fixture.service.describe(handle.canvas_id, {}, fixture.ctx);
    expect(described.tables[0]?.columns).toContainEqual(
      expect.objectContaining({ name: 'TM_ZONES', type: 'DOUBLE', valueKind: 'categorical' }),
    );
    expect(described.tables[0]?.provenance.envelope).toMatchObject({
      summaries: [],
      parameters: [expect.objectContaining({ valueKind: 'categorical' })],
    });
  } finally {
    await fixture.close();
  }
});

it('presents the captured default ten-site comparison through the real tool and native staging', async () => {
  const fixture = await nativeFixture();
  const captured = ComparisonOutputSchema.omit({ rowCount: true, dataset: true }).parse(
    JSON.parse(
      await readFile(new URL('../../fixtures/comparison-full.json', import.meta.url), 'utf8'),
    ),
  );
  const source = initPowerService({
    config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: true },
  });
  vi.spyOn(source, 'validateRequest').mockResolvedValue();
  vi.spyOn(source, 'point').mockImplementation(async (request) => {
    const location = captured.locations.find(
      (location) =>
        location.latitude === request.latitude && location.longitude === request.longitude,
    )!;
    return {
      ...PowerDatasetSchema.parse({
        ...location,
        rows: captured.rows.filter((row) => row.locationId === location.locationId),
      }),
      request,
    };
  });
  try {
    const result = await runToolContract(
      compareLocationsTool,
      compareLocationsTool.input.parse(captured.request),
    );
    expect(result.isError).not.toBe(true);
    const output = ComparisonOutputSchema.parse(result.structuredContent);
    expect(output.request).toEqual(captured.request);
    expect(output.locations).toHaveLength(10);
    expect(output.summaryDatasets!.buckets.rowCount).toBe(captured.summaries.length);
    expect(output.summaryDatasets!.locations.rowCount).toBe(
      captured.locations.reduce((sum, location) => sum + location.summaries.length, 0),
    );
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    expect(text.length).toBeLessThanOrEqual(40000);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(40000);
    for (const handle of [output.dataset!, ...Object.values(output.summaryDatasets!)]) {
      expect(text).toContain(handle.table);
      expect(text).toContain(handle.canvas_id);
      expect(text).toContain(String(handle.rowCount));
    }
  } finally {
    vi.restoreAllMocks();
    source.dispose();
    await fixture.close();
  }
});

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
  const source = initPowerService({
    fetch: fetcher,
    config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: true },
  });
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
