/** @fileoverview Complete structured and rendered analytical response budgets. @module tests/services/canvas/response-budget */

import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POWER_LIMITS } from '@/config/server-config.js';
import { ComparisonOutputSchema } from '@/mcp-server/tools/definitions/comparison-contracts.js';
import { formatFaithfully } from '@/services/canvas/format.js';
import { dataset, nativeFixture } from './fixture.js';

function renderedLength(value: object): number {
  return formatFaithfully(value).reduce((total, block) => total + block.text.length, 0);
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
    const captured = ComparisonOutputSchema.omit({ rowCount: true, dataset: true }).parse(
      JSON.parse(
        await readFile(new URL('../../fixtures/comparison-full.json', import.meta.url), 'utf8'),
      ),
    );
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
      expect(JSON.stringify(description).length).toBeLessThanOrEqual(40000);
      expect(renderedLength(description)).toBeLessThanOrEqual(40000);
    }
    const read = async (handle: typeof handles.buckets) => {
      const rows = [];
      for (let offset = 0; offset < handle.rowCount; offset += 20) {
        const page = await fixture.service.query(
          handle.canvas_id,
          { sql: `SELECT * FROM ${handle.table} ORDER BY summaryIndex LIMIT 20 OFFSET ${offset}` },
          fixture.ctx,
        );
        expect(JSON.stringify(page).length).toBeLessThanOrEqual(40000);
        expect(renderedLength(page)).toBeLessThanOrEqual(40000);
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
  it.each([2, 3])(
    'rolls back every comparison table when registration %i fails',
    async (failureAt) => {
      const captured = ComparisonOutputSchema.omit({ rowCount: true, dataset: true }).parse(
        JSON.parse(
          await readFile(new URL('../../fixtures/comparison-full.json', import.meta.url), 'utf8'),
        ),
      );
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
    const captured = ComparisonOutputSchema.omit({ rowCount: true, dataset: true }).parse(
      JSON.parse(
        await readFile(new URL('../../fixtures/comparison-full.json', import.meta.url), 'utf8'),
      ),
    );
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

  it('rejects oversized multi-cell period summaries before acquiring or registering native state', async () => {
    const base = dataset(365);
    const summaries = base.rows.map((row) => ({
      parameter: 'T2M',
      periodKey: row.periodKey,
      periodKind: row.periodKind,
      units: 'C',
      validCellCount: row.T2M === null ? 0 : 3,
      missingCellCount: row.T2M === null ? 3 : 0,
      min: row.T2M,
      mean: row.T2M,
      max: row.T2M,
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
    const outcome = await fixture.service
      .present(regional, undefined, fixture.ctx, 'nasa_power_get_region')
      .then(
        () => ({ accepted: true }),
        (error: unknown) => ({ accepted: false, error }),
      );
    expect.soft(outcome).toMatchObject({
      accepted: false,
      error: {
        data: {
          reason: 'dataset_limit',
          recovery: {
            hint: 'Narrow the date window, region, selected parameters, or location count and retry the producing tool.',
          },
        },
      },
    });
    expect.soft(acquire.mock.calls.length).toBe(0);
    expect.soft(register.mock.calls.length).toBe(0);
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

  it('rejects SQL output whose structured JSON fits but faithful rendering exceeds the budget', async () => {
    const base = dataset();
    base.rows = base.rows.map((row) => ({
      ...row,
      label: `https://example.org/observations/${'x'.repeat(40)}`,
    }));
    const handle = (
      await fixture.service.present(base, undefined, fixture.ctx, 'nasa_power_get_timeseries')
    ).dataset!;
    const expected = {
      canvas_id: handle.canvas_id,
      columns: ['label'],
      rows: base.rows.map(({ label }) => ({ label })),
      rowCount: base.rows.length,
      shownCount: base.rows.length,
      truncated: false,
      countSemantics: 'exact',
    };
    expect(JSON.stringify(expected).length).toBeLessThan(POWER_LIMITS.inlineCharacters);
    expect(renderedLength(expected)).toBeGreaterThan(POWER_LIMITS.inlineCharacters);
    const outcome = await fixture.service
      .query(
        handle.canvas_id,
        {
          sql: `SELECT label FROM ${handle.table} ORDER BY CAST(periodKey AS INTEGER)`,
          rowLimit: 400,
        },
        fixture.ctx,
      )
      .then(
        () => ({ accepted: true }),
        (error: unknown) => ({ accepted: false, error }),
      );
    expect(outcome).toMatchObject({
      accepted: false,
      error: {
        data: {
          reason: 'query_limit',
          recovery: {
            hint: 'Reduce SQL length or narrow the SELECT projection and row limit, then retry nasa_power_dataframe_query.',
          },
        },
      },
    });
  });

  it('bounds aggregate describe provenance while preserving complete targeted table descriptions', async () => {
    const descriptions = [];
    let canvasId: string | undefined;
    for (let index = 0; index < 4; index++) {
      const base = dataset();
      const scientific = {
        ...base,
        metadata: {
          ...base.metadata,
          calibration: `instrument_${index}: ${'calibration-note '.repeat(600)}`,
        },
      };
      const staged = await fixture.service.present(
        scientific,
        canvasId,
        fixture.ctx,
        'nasa_power_get_timeseries',
      );
      const handle = staged.dataset!;
      canvasId = handle.canvas_id;
      const targeted = await fixture.service.describe(
        canvasId,
        { table: handle.table },
        fixture.ctx,
      );
      expect(targeted.tables).toHaveLength(1);
      expect(targeted.tables[0]?.provenance.envelope.metadata).toEqual(scientific.metadata);
      expect(JSON.stringify(targeted).length).toBeLessThanOrEqual(POWER_LIMITS.inlineCharacters);
      expect(renderedLength(targeted)).toBeLessThanOrEqual(POWER_LIMITS.inlineCharacters);
      descriptions.push(targeted);
    }
    const combined = {
      canvas_id: canvasId!,
      expiresAt: descriptions[0]!.expiresAt,
      tables: descriptions.flatMap(({ tables }) => tables),
    };
    expect(JSON.stringify(combined).length).toBeGreaterThan(POWER_LIMITS.inlineCharacters);
    await expect(fixture.service.describe(canvasId!, {}, fixture.ctx)).rejects.toMatchObject({
      data: { reason: 'query_limit', recovery: { hint: expect.stringMatching(/table/i) } },
    });
    const first = descriptions[0]!;
    const targetedAgain = await fixture.service.describe(
      canvasId!,
      { table: first.tables[0]!.table },
      fixture.ctx,
    );
    expect(targetedAgain.tables).toEqual(first.tables);
  });
});
