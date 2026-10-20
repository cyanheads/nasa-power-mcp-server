/** @fileoverview Fault injection only at native and state boundaries. @module tests/services/canvas/failure-boundaries */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataset, nativeFixture } from './fixture.js';

describe('canvas failure cleanup and atomic admission', () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  beforeEach(async () => {
    fixture = await nativeFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.close();
  });
  const source = 'nasa_power_get_timeseries';
  async function stage() {
    return fixture.service.present(dataset(), undefined, fixture.ctx, source);
  }

  it('drops a new empty canvas after failed native registration', async () => {
    vi.spyOn(fixture.provider, 'registerTable').mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.DatabaseError, 'forced native failure'),
    );
    await expect(stage()).rejects.toMatchObject({ code: JsonRpcErrorCode.DatabaseError });
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
    expect((await stage()).dataset).not.toBeNull();
  });
  it('rolls back the whole table after provenance storage fails', async () => {
    vi.spyOn(fixture.ctx.state, 'set').mockRejectedValueOnce(new Error('forced storage failure'));
    await expect(stage()).rejects.toThrow('forced storage failure');
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
    expect((await stage()).dataset).not.toBeNull();
  });
  it('retains failed cleanup reservations until native absence is confirmed', async () => {
    vi.spyOn(fixture.ctx.state, 'set').mockRejectedValue(new Error('forced storage failure'));
    const drop = vi
      .spyOn(fixture.provider, 'drop')
      .mockRejectedValue(new Error('forced drop failure'));
    for (let index = 0; index < 4; index++)
      await expect(stage()).rejects.toThrow('forced storage failure');
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(4);
    await expect(stage()).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    drop.mockRestore();
    await fixture.service.reconcile();
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
    vi.mocked(fixture.ctx.state.set).mockRestore();
    expect((await stage()).dataset).not.toBeNull();
  });
  it('cancels after registration and removes the new table and provenance', async () => {
    const controller = new AbortController();
    const original = fixture.ctx.state.set.bind(fixture.ctx.state);
    const set = vi.spyOn(fixture.ctx.state, 'set').mockImplementation(async (...args) => {
      await original(...args);
      controller.abort();
    });
    await expect(
      fixture.service.present(
        dataset(),
        undefined,
        { ...fixture.ctx, signal: controller.signal },
        source,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(set).toHaveBeenCalledOnce();
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
  });
  it('reserves table admission before an asynchronous registration settles', async () => {
    const handle = (await stage()).dataset!;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fixture.provider.registerTable.bind(fixture.provider);
    vi.spyOn(fixture.provider, 'registerTable').mockImplementationOnce(async (...args) => {
      enter();
      await barrier;
      return original(...args);
    });
    const pending = fixture.service.present(dataset(), handle.canvas_id, fixture.ctx, source);
    await entered;
    try {
      await expect(
        fixture.service.present(dataset(), handle.canvas_id, fixture.ctx, source),
      ).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
      await expect(
        fixture.service.describe(handle.canvas_id, {}, fixture.ctx),
      ).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    } finally {
      release();
    }
    await pending;
    expect((await fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).tables).toHaveLength(
      2,
    );
  });
  it('holds cancelled query admission until the native boundary actually settles', async () => {
    const handle = (await stage()).dataset!;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(fixture.provider, 'query').mockImplementationOnce(async (_id, _sql, _ctx, options) => {
      enter();
      await barrier;
      options?.signal?.throwIfAborted();
      return { columns: [], rows: [], rowCount: 0 };
    });
    const controller = new AbortController();
    const pending = fixture.service
      .query(handle.canvas_id, { sql: 'SELECT 1' }, { ...fixture.ctx, signal: controller.signal })
      .catch((error: unknown) => error);
    await entered;
    controller.abort();
    try {
      await expect(
        fixture.service.query(handle.canvas_id, { sql: 'SELECT 1' }, fixture.ctx),
      ).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    } finally {
      release();
    }
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(
      (await fixture.service.query(handle.canvas_id, { sql: 'SELECT 1 AS result' }, fixture.ctx))
        .rows,
    ).toEqual([{ result: 1 }]);
  });
});
