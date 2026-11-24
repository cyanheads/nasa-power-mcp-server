/** @fileoverview Producer response budgets, and complete SQL and describe results past them. @module tests/services/canvas/response-budget */

import { readFile } from 'node:fs/promises';
import { createInMemoryStorage } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POWER_LIMITS } from '@/config/server-config.js';
import { ComparisonOutputSchema } from '@/mcp-server/tools/definitions/comparison-contracts.js';
import { createCanvasService } from '@/services/canvas/canvas-service.js';
import { formatFaithfully } from '@/services/canvas/format.js';
import { normalizePoint, PointPayloadSchema } from '@/services/power/normalize.js';
import { aliasMembership } from '@/services/power/presets.js';
import { PowerRequestSchema } from '@/services/power/types.js';
import { dataset, nativeFixture } from './fixture.js';

function renderedLength(value: object): number {
  return formatFaithfully(value).reduce((total, block) => total + block.text.length, 0);
}

/** Size under the budget's two measures: serialized JSON and the faithful rendering. */
const measure = (value: object) => Math.max(JSON.stringify(value).length, renderedLength(value));

async function capturedComparison() {
  return ComparisonOutputSchema.omit({ rowCount: true, dataset: true }).parse(
    JSON.parse(
      await readFile(new URL('../../fixtures/comparison-full.json', import.meta.url), 'utf8'),
    ),
  );
}

/** The first three captured sites; the last bucket summary carries `padding` extra characters. */
async function threeSites(padding = 0) {
  const captured = await capturedComparison();
  const kept = new Set(['location_1', 'location_2', 'location_3']);
  const summaries = captured.summaries.filter((summary) => kept.has(summary.locationId));
  summaries.at(-1)!.units = `${summaries.at(-1)!.units}${'x'.repeat(padding)}`;
  return {
    ...captured,
    request: { ...captured.request, locations: captured.request.locations.slice(0, 3) },
    metadata: {
      ...captured.metadata,
      endpointUrls: captured.metadata.endpointUrls.slice(0, 3),
    },
    locations: captured.locations.slice(0, 3),
    summaries,
    possibleSharedGridCell: [],
    rows: captured.rows.filter((row) => kept.has(String(row.locationId))),
  };
}

/** The captured 58-column hour-group climatology, normalized for a selection of its codes. */
async function widePoint(parameters: string[]) {
  const payload = PointPayloadSchema.parse(
    JSON.parse(
      await readFile(new URL('../../fixtures/hour-wide-climatology.json', import.meta.url), 'utf8'),
    ),
  );
  const keep = new Set(
    Object.keys(payload.properties.parameter).filter((code) =>
      parameters.some(
        (selected) => code === selected || aliasMembership(selected)?.(code) === true,
      ),
    ),
  );
  payload.properties.parameter = Object.fromEntries(
    Object.entries(payload.properties.parameter).filter(([code]) => keep.has(code)),
  );
  return normalizePoint(
    payload,
    PowerRequestSchema.parse({
      latitude: 41.9,
      longitude: -93.6,
      temporalResolution: 'climatology',
      selection: { mode: 'parameters', parameters },
    }),
    {
      endpointUrl: 'https://power.larc.nasa.gov/',
      fetchedAt: '2026-10-29T00:00:00Z',
      cacheHit: false,
    },
  );
}

describe('complete analytical response budget', () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  beforeEach(async () => {
    fixture = await nativeFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.close();
  });

  it('stages captured ten-site default comparison summaries with reconstructable handles', async () => {
    const captured = await capturedComparison();
    delete captured.summaries[1]!.units;
    delete captured.locations[1]!.summaries[1]!.units;
    const output = await fixture.service.presentComparison(
      captured,
      undefined,
      fixture.ctx,
      'nasa_power_compare_locations',
    );
    expect(ComparisonOutputSchema.safeParse(output).success).toBe(true);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(40000);
    expect(renderedLength(output)).toBeLessThanOrEqual(40000);
    expect(output.request).toEqual(captured.request);
    expect(output.locations.map(({ summaries: _s, summaryCount: _c, ...rest }) => rest)).toEqual(
      captured.locations.map(({ summaries: _s, ...rest }) => rest),
    );
    const handles = output.summaryDatasets!;
    for (const handle of [output.dataset!, handles.buckets, handles.locations]) {
      const description = await fixture.service.describe(
        handle.canvas_id,
        { table: handle.table },
        fixture.ctx,
      );
      expect(description.tables[0]?.provenance.envelope).toMatchObject({
        dataset: { table: output.dataset!.table },
        summaryDatasets: {
          buckets: { table: handles.buckets.table },
          locations: { table: handles.locations.table },
        },
      });
    }
    const read = async (handle: typeof handles.buckets) => {
      const rows = [];
      for (let offset = 0; offset < handle.rowCount; offset += 20) {
        const page = await fixture.service.query(
          handle.canvas_id,
          { sql: `SELECT * FROM ${handle.table} ORDER BY summaryIndex LIMIT 20 OFFSET ${offset}` },
          fixture.ctx,
        );
        rows.push(...page.rows);
      }
      return rows.map(({ summaryIndex: _i, ...row }) =>
        row.units === null
          ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'units'))
          : row,
      );
    };
    expect(await read(handles.buckets)).toEqual(captured.summaries);
    expect(await read(handles.locations)).toEqual(
      captured.locations.flatMap((location) =>
        location.summaries.map((summary) => ({ locationId: location.locationId, ...summary })),
      ),
    );
    const pastEnd = await fixture.service.query(
      handles.buckets.canvas_id,
      { sql: `SELECT * FROM ${handles.buckets.table} LIMIT 20 OFFSET ${handles.buckets.rowCount}` },
      fixture.ctx,
    );
    expect(pastEnd.rows).toEqual([]);
    expect(pastEnd.rowCount).toBe(0);
  });
  it('counts a deferral notice when deciding to stage comparison summaries', async () => {
    const comparison = {
      ...(await threeSites()),
      /** The first three captured sites compared, the next two deferred. */
      deferredLocations: (await capturedComparison()).request.locations.slice(3, 5),
    };
    const notice =
      'Input locations 4–5 were not compared: send deferredLocations as locations in a second call.';
    const envelope = { ...comparison, rows: [], rowCount: comparison.rows.length, dataset: null };
    /** Pad a summary the compact envelope drops until the envelope sits 5 characters under budget. */
    const last = comparison.summaries.at(-1)!;
    last.units = `${last.units}${'x'.repeat(40_000 - 5 - measure(envelope))}`;
    expect(measure(envelope)).toBe(39_995);
    expect(measure({ ...envelope, notice })).toBeGreaterThan(40_000);
    const output = await fixture.service.presentComparison(
      comparison,
      undefined,
      fixture.ctx,
      'nasa_power_compare_locations',
      undefined,
      notice,
    );
    expect(output.summaries).toEqual(comparison.summaries.slice(0, 1));
    expect(output.locations.map((location) => location.summaryCount)).toEqual([10, 10, 10]);
    expect(output.summaryDatasets).toMatchObject({
      buckets: { rowCount: 75 },
      locations: { rowCount: 30 },
    });
    expect(measure({ ...output, notice })).toBeLessThanOrEqual(40_000);
  });
  describe('a comparison whose envelope without rows fits', () => {
    const present = async (padding: number) =>
      fixture.service.presentComparison(
        await threeSites(padding),
        undefined,
        fixture.ctx,
        'nasa_power_compare_locations',
      );
    /** Size of the observation-staged response with a one-row preview at this padding. */
    async function oneRowStaged(padding: number) {
      const staged = await present(padding);
      expect(staged.summaryDatasets).toBeUndefined();
      expect(staged.dataset).not.toBeNull();
      return measure({ ...staged, rows: staged.rows.slice(0, 1) });
    }

    it('stages observations alone while a one-row preview still fits', async () => {
      const room = 40_000 - (await oneRowStaged(0));
      const output = await present(room);
      expect(measure({ ...output, rows: output.rows.slice(0, 1) })).toBe(40_000);
      expect(output.summaryDatasets).toBeUndefined();
      expect(output.rows).toHaveLength(1);
      expect(output.summaries).toHaveLength(75);
      expect(output.dataset?.rowCount).toBe(39);
      expect(measure(output)).toBeLessThanOrEqual(40_000);
    });
    it('stages summaries instead of refusing once no one-row preview fits', async () => {
      const padding = 40_000 - (await oneRowStaged(0)) + 1;
      const source = await threeSites(padding);
      expect(measure({ ...source, rows: [], rowCount: 39, dataset: null })).toBeLessThan(40_000);
      const output = await present(padding);
      expect(output.summaries).toEqual(source.summaries.slice(0, 1));
      expect(output.locations.map((location) => location.summaryCount)).toEqual([10, 10, 10]);
      expect(output.summaryDatasets).toMatchObject({
        buckets: { rowCount: 75 },
        locations: { rowCount: 30 },
      });
      expect(output.dataset?.rowCount).toBe(39);
      expect(output.rows.length).toBeGreaterThan(0);
      expect(output.rows).toEqual(source.rows.slice(0, output.rows.length));
      expect(measure(output)).toBeLessThanOrEqual(40_000);
      const buckets = await fixture.service.query(
        output.summaryDatasets!.buckets.canvas_id,
        {
          sql: `SELECT units FROM ${output.summaryDatasets!.buckets.table} ORDER BY summaryIndex DESC LIMIT 1`,
        },
        fixture.ctx,
      );
      expect(buckets.rows).toEqual([{ units: source.summaries.at(-1)!.units }]);
    });
    it('refuses with a sized canvas_required split, not dataset_limit, without a workspace', async () => {
      const padding = 40_000 - (await oneRowStaged(0)) + 1;
      const inlineOnly = createCanvasService({
        storage: createInMemoryStorage(),
        config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
      });
      try {
        await expect(
          inlineOnly.presentComparison(
            await threeSites(padding),
            undefined,
            fixture.ctx,
            'nasa_power_compare_locations',
          ),
        ).rejects.toMatchObject({
          data: { reason: 'canvas_required', rowCount: 39, calls: expect.any(Array) },
        });
      } finally {
        await inlineOnly.shutdown();
      }
    });
  });
  it('stages point summaries instead of refusing when the envelope fits but no one-row preview does', async () => {
    const narrow = await widePoint(['SI_TRACKER_AVG', 'T2M', 'RH2M']);
    const last = narrow.summaries.at(-1)!;
    last.units = `${last.units}${'x'.repeat(40_000 - 5 - measure({ ...narrow, rows: [], rowCount: 13, dataset: null }))}`;
    expect(measure({ ...narrow, rows: [], rowCount: 13, dataset: null })).toBe(39_995);
    const output = await fixture.service.presentPoint(
      narrow,
      undefined,
      fixture.ctx,
      'nasa_power_get_climatology',
    );
    expect(output.summaries).toEqual(narrow.summaries.slice(0, 1));
    expect(output.summaryCount).toBe(narrow.summaries.length);
    expect(output.summaryDataset?.rowCount).toBe(narrow.summaries.length);
    expect(output.dataset?.rowCount).toBe(13);
    expect(output.rows).toEqual(narrow.rows.slice(0, output.rows.length));
    expect(output.rows.length).toBeGreaterThan(0);
    expect(measure(output)).toBeLessThanOrEqual(40_000);
  });
  it.each([2, 3])(
    'rolls back every comparison table when registration %i fails',
    async (failureAt) => {
      const captured = await capturedComparison();
      const register = fixture.provider.registerTable.bind(fixture.provider);
      let calls = 0;
      vi.spyOn(fixture.provider, 'registerTable').mockImplementation(async (...args) => {
        if (++calls === failureAt) throw new Error('registration failed');
        return register(...args);
      });
      await expect(
        fixture.service.presentComparison(
          captured,
          undefined,
          fixture.ctx,
          'nasa_power_compare_locations',
        ),
      ).rejects.toThrow('registration failed');
      expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
      vi.restoreAllMocks();
      const next = await fixture.service.presentComparison(
        captured,
        undefined,
        fixture.ctx,
        'nasa_power_compare_locations',
      );
      expect(
        (
          await fixture.service.describe(
            next.dataset!.canvas_id,
            { table: next.dataset!.table },
            fixture.ctx,
          )
        ).tables,
      ).toHaveLength(1);
    },
  );

  it('rolls back all comparison tables and provenance after a later metadata failure while preserving existing tables', async () => {
    const existing = (
      await fixture.service.present(dataset(), undefined, fixture.ctx, 'nasa_power_get_timeseries')
    ).dataset!;
    const captured = await capturedComparison();
    const write = fixture.storage.set.bind(fixture.storage);
    let count = 0;
    vi.spyOn(fixture.storage, 'set').mockImplementation(async (...args) => {
      await write(...args);
      if (++count === 3) throw new Error('later metadata failure');
    });
    await expect(
      fixture.service.presentComparison(
        captured,
        existing.canvas_id,
        fixture.ctx,
        'nasa_power_compare_locations',
      ),
    ).rejects.toThrow('later metadata failure');
    expect(
      (await fixture.provider.describe(existing.canvas_id, fixture.ctx)).map((table) => table.name),
    ).toEqual([existing.table]);
    expect((await fixture.storage.list('power/canvas/', fixture.ctx)).keys).toHaveLength(1);
    expect(
      (await fixture.service.describe(existing.canvas_id, {}, fixture.ctx)).tables.map(
        (table) => table.table,
      ),
    ).toEqual([existing.table]);
  });

  it('stages oversized multi-cell summaries alongside observations in one batch', async () => {
    const base = dataset(365);
    const summaries = base.rows.map((row) => ({
      parameter: 'T2M',
      periodKey: row.periodKey,
      periodKind: row.periodKind,
      units: 'C',
      validCellCount: row.T2M === null ? 0 : 3,
      missingCellCount: row.T2M === null ? 3 : 0,
      min: typeof row.T2M === 'number' ? row.T2M : null,
      mean: typeof row.T2M === 'number' ? row.T2M : null,
      max: typeof row.T2M === 'number' ? row.T2M : null,
    }));
    const regional = {
      ...base,
      cellCount: 3,
      request: {
        latitudeMin: 45,
        latitudeMax: 47,
        longitudeMin: -123,
        longitudeMax: -121,
        parameter: 'T2M',
        temporalResolution: 'daily',
        startDate: '2024-01-01',
        endDate: '2024-12-30',
      },
      summaries,
      rows: base.rows.flatMap((row) =>
        [0, 1, 2].map((cell) => ({ ...row, cellId: `cell_${cell}`, latitude: 45 + cell })),
      ),
    };
    expect(JSON.stringify(summaries).length).toBeGreaterThan(POWER_LIMITS.inlineCharacters);
    const acquire = vi.spyOn(fixture.canvas, 'acquire');
    const register = vi.spyOn(fixture.provider, 'registerTable');
    const output = await fixture.service.presentRegion(
      regional,
      undefined,
      fixture.ctx,
      'nasa_power_get_region',
    );
    expect(output.rowCount).toBe(1095);
    expect(output.summaryCount).toBe(365);
    expect(output.summaryDataset?.rowCount).toBe(365);
    expect(output.dataset?.canvas_id).toBe(output.summaryDataset?.canvas_id);
    expect(acquire).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(40000);
    expect(renderedLength(output)).toBeLessThanOrEqual(40000);
  });

  it('stages oversized point summaries alongside observations in one batch', async () => {
    const wide = await widePoint([
      'ALLSKY_SFC_SW_DWN_HR',
      'ALLSKY_SFC_SW_DIFF_HR',
      'SI_TRACKER_AVG',
      'T2M',
      'RH2M',
      'WS10M',
      'PS',
      'PRECTOTCORR',
    ]);
    expect(wide.parameters).toHaveLength(58);
    expect(
      JSON.stringify({ ...wide, rows: [], rowCount: 13, dataset: null }).length,
    ).toBeGreaterThan(POWER_LIMITS.inlineCharacters);
    const acquire = vi.spyOn(fixture.canvas, 'acquire');
    const register = vi.spyOn(fixture.provider, 'registerTable');
    const output = await fixture.service.presentPoint(
      wide,
      undefined,
      fixture.ctx,
      'nasa_power_get_climatology',
    );
    const { rows: _rows, summaries: _summaries, ...envelope } = wide;
    expect(output).toMatchObject({
      ...envelope,
      summaries: wide.summaries.slice(0, 1),
      summaryCount: 116,
      rowCount: 13,
    });
    expect(output.rows).toEqual(wide.rows.slice(0, output.rows.length));
    expect(output.summaryDataset).toMatchObject({
      canvas_id: output.dataset?.canvas_id,
      rowCount: 116,
    });
    expect(output.dataset?.rowCount).toBe(13);
    expect(acquire).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(40000);
    expect(renderedLength(output)).toBeLessThanOrEqual(40000);
  });

  it('presents a point whose envelope without rows fits exactly as the single-table path does', async () => {
    const narrow = await widePoint(['SI_TRACKER_AVG', 'T2M', 'RH2M']);
    const acquire = vi.spyOn(fixture.canvas, 'acquire');
    const inline = await fixture.service.presentPoint(
      narrow,
      undefined,
      fixture.ctx,
      'nasa_power_get_climatology',
    );
    expect(inline).toEqual(
      await fixture.service.present(narrow, undefined, fixture.ctx, 'nasa_power_get_climatology'),
    );
    expect(inline).toEqual({ ...narrow, rowCount: 13, dataset: null });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('counts a point summary stage as two tables against the per-canvas table cap', async () => {
    const summarized = await widePoint([
      'ALLSKY_SFC_SW_DWN_HR',
      'ALLSKY_SFC_SW_DIFF_HR',
      'SI_TRACKER_AVG',
      'T2M',
      'RH2M',
      'WS10M',
      'PS',
      'PRECTOTCORR',
    ]);
    /** Observations overflow inline while the envelope without rows fits: one table. */
    const observed = await widePoint([
      'ALLSKY_SFC_SW_DIFF_HR',
      'SI_TRACKER_AVG',
      'T2M',
      'RH2M',
      'WS10M',
      'PS',
      'PRECTOTCORR',
    ]);
    const stage = (data: typeof summarized, canvasId?: string) =>
      fixture.service.presentPoint(data, canvasId, fixture.ctx, 'nasa_power_get_climatology');
    const tables = async (canvasId: string) =>
      (await fixture.provider.describe(canvasId, fixture.ctx)).length;
    const refusal = {
      message: 'Analytical workspace memory or table capacity is exhausted.',
      data: {
        reason: 'canvas_capacity_exhausted',
        recovery: {
          hint: 'Reuse a canvas_id already returned to you, or wait for staged tables to expire before retrying.',
        },
        retryable: true,
      },
    };
    /** Four summary stages reach the cap exactly; a fifth would need two more. */
    const first = await stage(summarized);
    expect(first.summaryDataset?.canvas_id).toBe(first.dataset?.canvas_id);
    const full = first.dataset!.canvas_id;
    for (let index = 1; index < POWER_LIMITS.tablesPerCanvas / 2; index++)
      await stage(summarized, full);
    expect(await tables(full)).toBe(POWER_LIMITS.tablesPerCanvas);
    await expect(stage(summarized, full)).rejects.toMatchObject(refusal);
    expect(await tables(full)).toBe(POWER_LIMITS.tablesPerCanvas);
    /** At seven tables a summary stage would make nine, while an observation-only stage fits. */
    const single = await stage(observed);
    expect(single.summaryDataset).toBeUndefined();
    const seven = single.dataset!.canvas_id;
    for (let index = 0; index < 3; index++) await stage(summarized, seven);
    expect(await tables(seven)).toBe(POWER_LIMITS.tablesPerCanvas - 1);
    await expect(stage(summarized, seven)).rejects.toMatchObject(refusal);
    expect(await tables(seven)).toBe(POWER_LIMITS.tablesPerCanvas - 1);
    const last = await stage(observed, seven);
    expect(last.summaryDataset).toBeUndefined();
    expect(last.dataset?.canvas_id).toBe(seven);
    expect(await tables(seven)).toBe(POWER_LIMITS.tablesPerCanvas);
  });

  it('stages the full point table while fitting metadata, pointer and whole-row preview on both surfaces', async () => {
    const base = dataset();
    const point = {
      ...base,
      request: {
        latitude: 47.6,
        longitude: -122.3,
        temporalResolution: 'daily',
        startDate: '2023-01-01',
        endDate: '2024-02-04',
        selection: { mode: 'parameters', parameters: ['T2M', 'ORT'] },
      },
      expansions: {},
      omittedParameters: [],
      summaries: [
        {
          parameter: 'T2M',
          periodKind: 'day',
          units: 'C',
          validCount: 290,
          missingCount: 110,
          fillCount: 110,
          absentKeyCount: 0,
          firstReturnedKey: '0',
          lastReturnedKey: '399',
          lastValidPeriodKey: '399',
          lastValidDate: '2024-02-04',
          mean: 206.98275862068965,
          min: 0,
          max: 399.125,
        },
      ],
    };
    const output = await fixture.service.present(
      point,
      undefined,
      fixture.ctx,
      'nasa_power_get_timeseries',
    );
    expect(output).toMatchObject({
      metadata: point.metadata,
      request: point.request,
      summaries: point.summaries,
      expansions: {},
      omittedParameters: [],
      parameters: point.parameters,
      rowCount: point.rows.length,
    });
    expect(output.rows.length).toBeGreaterThan(0);
    expect(output.rows.length).toBeLessThan(point.rows.length);
    expect(output.rows).toEqual(point.rows.slice(0, output.rows.length));
    const handle = output.dataset!;
    expect(handle).toMatchObject({
      rowCount: point.rows.length,
      describeTool: 'nasa_power_dataframe_describe',
      queryTool: 'nasa_power_dataframe_query',
    });
    const stored = await fixture.provider.query(
      handle.canvas_id,
      `SELECT * FROM ${handle.table} ORDER BY CAST(periodKey AS INTEGER)`,
      fixture.ctx,
      { rowLimit: 1000 },
    );
    expect(stored.rows).toEqual(point.rows);
    expect.soft(JSON.stringify(output).length).toBeLessThanOrEqual(POWER_LIMITS.inlineCharacters);
    expect.soft(renderedLength(output)).toBeLessThanOrEqual(POWER_LIMITS.inlineCharacters);
  });

  it('preserves ordinary single-table staging near the existing response budget', async () => {
    const source = { ...dataset(), metadata: { note: 'x'.repeat(37500) } };
    const output = await fixture.service.present(
      source,
      undefined,
      fixture.ctx,
      'nasa_power_get_timeseries',
    );
    expect(output.dataset).not.toBeNull();
    expect(output.metadata).toEqual(source.metadata);
    expect(Math.max(JSON.stringify(output).length, renderedLength(output))).toBeGreaterThan(39000);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(40000);
    expect(renderedLength(output)).toBeLessThanOrEqual(40000);
  });

  it('returns every SQL row whose faithful rendering exceeds the producer inline budget', async () => {
    const base = dataset();
    const url = (key: string) => `https://example.org/observations/${'x'.repeat(40)}/${key}`;
    base.rows = base.rows.map((row) => ({ ...row, label: url(row.periodKey) }));
    const handle = (
      await fixture.service.present(base, undefined, fixture.ctx, 'nasa_power_get_timeseries')
    ).dataset!;
    const output = await fixture.service.query(
      handle.canvas_id,
      {
        sql: `SELECT label FROM ${handle.table} ORDER BY CAST(periodKey AS INTEGER)`,
        rowLimit: 400,
      },
      fixture.ctx,
    );
    expect(output).toEqual({
      canvas_id: handle.canvas_id,
      columns: ['label'],
      rows: base.rows.map(({ periodKey }) => ({ label: url(periodKey) })),
      rowCount: 400,
      shownCount: 400,
      truncated: false,
      countSemantics: 'exact',
    });
    const text = formatFaithfully(output)[0]!.text;
    expect(text.length).toBeGreaterThan(POWER_LIMITS.inlineCharacters);
    for (const { periodKey } of base.rows) expect(text).toContain(`(<${url(periodKey)}>)`);
  });

  it('describes every table of a canvas at its table cap, each as its targeted description', async () => {
    const targeted = [];
    const calibrations: string[] = [];
    let canvasId: string | undefined;
    for (let index = 0; index < POWER_LIMITS.tablesPerCanvas; index++) {
      const base = dataset();
      const calibration = `instrument_${index}: ${'calibration-note '.repeat(600)}`;
      const scientific = { ...base, metadata: { ...base.metadata, calibration } };
      const handle = (
        await fixture.service.present(
          scientific,
          canvasId,
          fixture.ctx,
          'nasa_power_get_timeseries',
        )
      ).dataset!;
      canvasId = handle.canvas_id;
      const one = await fixture.service.describe(canvasId, { table: handle.table }, fixture.ctx);
      expect(one.tables).toHaveLength(1);
      expect(one.tables[0]?.provenance.envelope.metadata).toEqual(scientific.metadata);
      targeted.push(one.tables[0]!);
      calibrations.push(calibration);
    }
    const whole = await fixture.service.describe(canvasId!, {}, fixture.ctx);
    const byTable = (a: { table: string }, b: { table: string }) => a.table.localeCompare(b.table);
    expect([...whole.tables].sort(byTable)).toEqual([...targeted].sort(byTable));
    expect(JSON.stringify(whole).length).toBeGreaterThan(POWER_LIMITS.inlineCharacters);
    const text = formatFaithfully(whole)[0]!.text;
    expect(text.length).toBeGreaterThan(POWER_LIMITS.inlineCharacters);
    for (const [index, { table }] of targeted.entries()) {
      expect(text).toContain(table);
      expect(text).toContain(calibrations[index]!);
    }
    await expect(
      fixture.service.describe(canvasId!, { table: 'power_absent' }, fixture.ctx),
    ).rejects.toMatchObject({ data: { reason: 'missing_table' } });
  });

  it('stages point summaries whose single-table description exceeds the producer inline budget', async () => {
    const wide = await widePoint([
      'ALLSKY_SFC_SW_DWN_HR',
      'ALLSKY_SFC_SW_DIFF_HR',
      'SI_TRACKER_AVG',
      'T2M',
      'RH2M',
      'WS10M',
      'PS',
      'PRECTOTCORR',
    ]);
    const stage = (data: typeof wide) =>
      fixture.service.presentPoint(data, undefined, fixture.ctx, 'nasa_power_get_climatology');
    const plain = await stage(wide);
    /** Padding that leaves room for a one-row preview; a description repeats the column list instead. */
    const padding =
      POWER_LIMITS.inlineCharacters - measure({ ...plain, rows: plain.rows.slice(0, 1) }) - 100;
    const padded = { ...wide, metadata: { ...wide.metadata, note: 'x'.repeat(padding) } };
    const output = await stage(padded);
    expect(output.summaryCount).toBe(116);
    expect(output.metadata).toEqual(padded.metadata);
    expect(measure(output)).toBeLessThanOrEqual(POWER_LIMITS.inlineCharacters);
    const sizes = [];
    for (const handle of [output.dataset!, output.summaryDataset!]) {
      const description = await fixture.service.describe(
        handle.canvas_id,
        { table: handle.table },
        fixture.ctx,
      );
      expect(description.tables[0]?.provenance.envelope).toMatchObject({
        metadata: padded.metadata,
        dataset: { table: output.dataset!.table },
        summaryDataset: { table: output.summaryDataset!.table },
      });
      sizes.push(measure(description));
    }
    expect(Math.max(...sizes)).toBeGreaterThan(POWER_LIMITS.inlineCharacters);
  });
});
