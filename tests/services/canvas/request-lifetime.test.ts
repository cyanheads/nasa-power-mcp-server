/** @fileoverview Native canvas cleanup outlives its producing HTTP request. @module tests/services/canvas/request-lifetime */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POWER_LIMITS } from '@/config/server-config.js';
import { dataframeDescribeTool } from '@/mcp-server/tools/definitions/nasa-power-dataframe-describe.tool.js';
import { dataframeDropTool } from '@/mcp-server/tools/definitions/nasa-power-dataframe-drop.tool.js';
import { dataset, nativeFixture } from './fixture.js';

describe('producer request lifetime', () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  beforeEach(async () => {
    fixture = await nativeFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.close();
  });

  it('drops from fresh requests after the producing request closes, with true then false on both surfaces', async () => {
    const producer = new AbortController();
    const ctx = createMockContext({ signal: producer.signal });
    const handle = (
      await fixture.service.present(dataset(), undefined, ctx, 'nasa_power_get_timeseries')
    ).dataset!;
    const retained = (
      await fixture.service.present(
        dataset(),
        handle.canvas_id,
        fixture.ctx,
        'nasa_power_get_timeseries',
      )
    ).dataset!;
    expect((await fixture.storage.list('power/canvas/', createMockContext())).keys).toHaveLength(2);
    producer.abort(new Error('Connection closed'));
    for (const dropped of [true, false]) {
      const result = await runToolContract(dataframeDropTool, {
        canvas_id: handle.canvas_id,
        table: handle.table,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        canvas_id: handle.canvas_id,
        table: handle.table,
        dropped,
      });
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      for (const value of [handle.canvas_id, handle.table, String(dropped)])
        expect(text).toContain(value);
    }
    expect(
      (await fixture.provider.describe(handle.canvas_id, fixture.ctx)).map((table) => table.name),
    ).toEqual([retained.table]);
    expect(
      (await fixture.service.describe(handle.canvas_id, {}, createMockContext())).tables,
    ).toHaveLength(1);
    await fixture.service.drop(handle.canvas_id, { table: retained.table }, fixture.ctx);
    const retired = await runToolContract(dataframeDropTool, {
      canvas_id: handle.canvas_id,
      table: retained.table,
    });
    expect(retired.isError).toBe(true);
    expect(retired.structuredContent).toMatchObject({
      error: { data: { reason: 'canvas_not_found' } },
    });
    expect((await fixture.storage.list('power/canvas/', createMockContext())).keys).toEqual([]);
  });

  it('reads original provenance from a fresh request after the producer connection closes', async () => {
    const producer = new AbortController();
    const ctx = createMockContext({ signal: producer.signal });
    const source = dataset();
    const handle = (
      await fixture.service.present(source, undefined, ctx, 'nasa_power_get_timeseries')
    ).dataset!;
    producer.abort(new Error('Connection closed'));
    const result = await runToolContract(dataframeDescribeTool, {
      canvas_id: handle.canvas_id,
      table: handle.table,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      tables: [
        {
          table: handle.table,
          rowCount: 400,
          provenance: {
            sourceTool: 'nasa_power_get_timeseries',
            envelope: { metadata: source.metadata, parameters: source.parameters },
          },
        },
      ],
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    for (const value of [handle.table, 'nasa_power_get_timeseries', 'source\nline', 'T2M'])
      expect(text).toContain(value);
  });

  it('reclaims native-expired canvases after producer abort without leaking admission slots', async () => {
    const producer = new AbortController();
    const ctx = createMockContext({ signal: producer.signal });
    await fixture.service.present(dataset(), undefined, ctx, 'nasa_power_get_timeseries');
    producer.abort(new Error('Connection closed'));
    fixture.advance(POWER_LIMITS.canvasAbsoluteTtlMs + 1);
    await fixture.registry.sweep();
    await fixture.service.reconcile();
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
    expect((await fixture.storage.list('power/canvas/', createMockContext())).keys).toEqual([]);
    for (let index = 0; index < POWER_LIMITS.canvasesPerTenant; index++) {
      const output = await fixture.service.present(
        dataset(),
        undefined,
        createMockContext(),
        'nasa_power_get_timeseries',
      );
      expect(output.dataset).not.toBeNull();
    }
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(POWER_LIMITS.canvasesPerTenant);
  });
  it('rolls back cancelled registration with an actual signal-bound producing context', async () => {
    const producer = new AbortController();
    const ctx = createMockContext({ signal: producer.signal });
    const original = fixture.storage.set.bind(fixture.storage);
    vi.spyOn(fixture.storage, 'set').mockImplementationOnce(async (...args) => {
      await original(...args);
      producer.abort(new Error('Connection closed'));
    });
    await expect(
      fixture.service.present(dataset(), undefined, ctx, 'nasa_power_get_timeseries'),
    ).rejects.toThrow('Connection closed');
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
    expect((await fixture.storage.list('power/canvas/', createMockContext())).keys).toEqual([]);
    await fixture.service.reconcile();
    for (let index = 0; index < POWER_LIMITS.canvasesPerTenant; index++) {
      expect(
        (
          await fixture.service.present(
            dataset(),
            undefined,
            createMockContext(),
            'nasa_power_get_timeseries',
          )
        ).dataset,
      ).not.toBeNull();
    }
  });
});
