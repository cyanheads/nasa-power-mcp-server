/** @fileoverview Operator sizing reaches native lifecycle and service accounting. @module tests/services/canvas/configured-limits */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { DuckDBInstance } from '@duckdb/node-api';
import { expect, it, vi } from 'vitest';
import { ProvenanceSchema } from '@/services/canvas/types.js';
import { dataset, nativeFixture } from './fixture.js';

it('applies configured tenant/process caps, provenance retention and native expiry', async () => {
  const create = vi.spyOn(DuckDBInstance, 'create');
  const f = await nativeFixture(true, {
    maxCanvasesPerTenant: 1,
    maxCanvasesPerProcess: 2,
    ttlMs: 60_000,
    absoluteCapMs: 120_000,
    memoryLimitMb: 128,
  });
  const stage = (ctx = f.ctx) =>
    f.service.present(dataset(), undefined, ctx, 'nasa_power_get_timeseries');
  const set = vi.spyOn(f.storage, 'set');
  try {
    const one = (await stage()).dataset!;
    expect(create).toHaveBeenCalledWith(
      ':memory:',
      expect.objectContaining({ memory_limit: '128MB' }),
    );
    expect(set.mock.calls[0]?.[3]).toEqual({ ttl: 120 });
    expect(
      Date.parse(one.expiresAt) -
        Date.parse(ProvenanceSchema.parse(set.mock.calls[0]![1]).createdAt),
    ).toBe(60_000);
    await expect(stage()).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    const other = createMockContext({ tenantId: 'other' });
    await expect(f.service.describe(one.canvas_id, {}, other)).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
    await stage(other);
    await expect(stage(createMockContext({ tenantId: 'third' }))).rejects.toMatchObject({
      data: { reason: 'canvas_capacity_exhausted' },
    });
    f.advance(120_001);
    const destroy = vi
      .spyOn(f.provider, 'destroyCanvas')
      .mockRejectedValue(new Error('native busy'));
    await f.service.reconcile();
    expect(destroy).toHaveBeenCalledTimes(2);
    await expect(stage()).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    destroy.mockRestore();
    await f.registry.sweep();
    await f.service.reconcile();
    expect((await stage()).dataset).not.toBeNull();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it('honors a tenant allowance above the former fixed count without exceeding its configured cap', async () => {
  const f = await nativeFixture(true, { maxCanvasesPerTenant: 5, maxCanvasesPerProcess: 6 });
  try {
    for (let i = 0; i < 5; i++)
      await f.service.present(dataset(), undefined, f.ctx, 'nasa_power_get_timeseries');
    expect(f.canvas.countForTenant(f.ctx)).toBe(5);
    await expect(
      f.service.present(dataset(), undefined, f.ctx, 'nasa_power_get_timeseries'),
    ).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
  } finally {
    await f.close();
  }
});
