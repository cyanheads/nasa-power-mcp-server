/** @fileoverview Fault injection only at native and state boundaries. @module tests/services/canvas/failure-boundaries */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQueryTool } from '@/mcp-server/tools/definitions/nasa-power-dataframe-query.tool.js';
import { safeCanvasError } from '@/services/canvas/errors.js';
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

  it('bounds SQL diagnostics and removes quoted engine paths, CR stack lines and native causes', () => {
    const error = new McpError(
      JsonRpcErrorCode.ValidationError,
      'Unknown column missing_column in "/private/engine directory/state.db" and "C:\\engine directory\\state.db"\r    at native secret',
      { reason: 'invalid_sql', binderMessage: 'private' },
      { cause: new Error('secret') },
    );
    expect.assertions(3);
    try {
      safeCanvasError(error);
    } catch (failure) {
      expect(failure).toBeInstanceOf(McpError);
      expect(failure).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'Unknown column missing_column in "[path]" and "[path]"',
        data: {
          reason: 'invalid_sql',
          recovery: {
            hint: 'Check SQL syntax and column names against nasa_power_dataframe_describe using the same canvas_id.',
          },
        },
      });
      expect((failure as McpError).cause).toBeUndefined();
    }
  });

  it('retires the final dropped table and immediately reclaims its canvas slot', async () => {
    const handles = [];
    for (let index = 0; index < 4; index++) handles.push((await stage()).dataset!);
    await expect(stage()).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    const handle = handles[0]!;
    expect(
      await fixture.service.drop(handle.canvas_id, { table: handle.table }, fixture.ctx),
    ).toMatchObject({ dropped: true });
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(3);
    for (const operation of [
      () => fixture.service.describe(handle.canvas_id, {}, fixture.ctx),
      () => fixture.service.query(handle.canvas_id, { sql: 'SELECT 1' }, fixture.ctx),
      () => fixture.service.drop(handle.canvas_id, { table: handle.table }, fixture.ctx),
    ])
      await expect(operation()).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
    expect((await stage()).dataset!.canvas_id).not.toBe(handle.canvas_id);
  });

  it('drops a new empty canvas after failed native registration', async () => {
    vi.spyOn(fixture.provider, 'registerTable').mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.DatabaseError, 'forced native failure'),
    );
    await expect(stage()).rejects.toMatchObject({ code: JsonRpcErrorCode.DatabaseError });
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
    expect((await stage()).dataset).not.toBeNull();
  });
  it.each([
    ['SELECT misspelled_column FROM TABLE_NAME', 'misspelled_column'],
    ['SELECT imaginary_function(1)', 'imaginary_function'],
    ['SELECT * FROM missing_observations', 'missing_observations'],
    ['SELECT FROM', 'syntax'],
    ["SELECT CAST('not_a_number' AS INTEGER)", 'not_a_number'],
    ["SELECT * FROM read_csv('/etc/passwd')", 'read_csv'],
  ])('retains actionable native SQL diagnostics for %s', async (sql, detail) => {
    const handle = (await stage()).dataset!;
    await expect(
      fixture.service.query(
        handle.canvas_id,
        { sql: sql.replaceAll('TABLE_NAME', handle.table) },
        fixture.ctx,
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining(detail) });
    const result = await runToolContract(dataframeQueryTool, {
      canvas_id: handle.canvas_id,
      sql: sql.replaceAll('TABLE_NAME', handle.table),
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain(detail);
    expect(
      result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    ).toContain(detail);
    expect(JSON.stringify(result)).not.toContain('"cause"');
    expect(JSON.stringify(result)).not.toContain('binderMessage');
  });
  it.each([
    JsonRpcErrorCode.DatabaseError,
    JsonRpcErrorCode.Timeout,
    JsonRpcErrorCode.RequestCancelled,
    JsonRpcErrorCode.ServiceUnavailable,
  ])('keeps operational error %i generic and classified', async (code) => {
    const handle = (await stage()).dataset!;
    vi.spyOn(fixture.provider, 'query').mockRejectedValueOnce(
      new McpError(
        code,
        'engine /private/secret/database.duckdb',
        { reason: 'cancelled', private: 'secret' },
        { cause: new Error('private stack') },
      ),
    );
    const failure = await fixture.service
      .query(handle.canvas_id, { sql: 'SELECT 1' }, fixture.ctx)
      .catch((error) => error);
    expect(failure).toMatchObject({
      code,
      message: 'The analytical engine could not complete this operation.',
      data: { reason: 'cancelled' },
    });
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain('secret');
  });
  it('rolls back the whole table after provenance storage fails', async () => {
    vi.spyOn(fixture.storage, 'set').mockRejectedValueOnce(new Error('forced storage failure'));
    await expect(stage()).rejects.toThrow('forced storage failure');
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
    expect((await stage()).dataset).not.toBeNull();
  });
  it('retains the final canvas reservation when metadata cleanup fails, then reconciles it', async () => {
    const handle = (await stage()).dataset!;
    const remove = vi
      .spyOn(fixture.storage, 'delete')
      .mockRejectedValueOnce(new Error('metadata unavailable'));
    await expect(
      fixture.service.drop(handle.canvas_id, { table: handle.table }, fixture.ctx),
    ).rejects.toThrow('metadata unavailable');
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(1);
    remove.mockRestore();
    await fixture.service.reconcile();
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
    await expect(fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).rejects.toMatchObject(
      { data: { reason: 'canvas_not_found' } },
    );
  });
  it('serializes final-table removal with queries and registrations until native cleanup settles', async () => {
    const handle = (await stage()).dataset!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = fixture.provider.drop.bind(fixture.provider);
    vi.spyOn(fixture.provider, 'drop').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const pending = fixture.service.drop(handle.canvas_id, { table: handle.table }, fixture.ctx);
    await entered.promise;
    try {
      await expect(
        fixture.service.query(handle.canvas_id, { sql: 'SELECT 1' }, fixture.ctx),
      ).rejects.toMatchObject({ data: { reason: 'canvas_busy', retryable: true } });
      await expect(
        fixture.service.present(dataset(), handle.canvas_id, fixture.ctx, source),
      ).rejects.toMatchObject({
        data: {
          reason: 'canvas_busy',
          recovery: {
            hint: 'A query or operation is already in flight; retry this call when it returns.',
          },
        },
      });
      expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(1);
    } finally {
      release.resolve();
    }
    await expect(pending).resolves.toMatchObject({ dropped: true });
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
  });
  it('retains failed cleanup reservations until native absence is confirmed', async () => {
    vi.spyOn(fixture.storage, 'set').mockRejectedValue(new Error('forced storage failure'));
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
    vi.mocked(fixture.storage.set).mockRestore();
    expect((await stage()).dataset).not.toBeNull();
  });
  it('cancels after registration and removes the new table and provenance', async () => {
    const controller = new AbortController();
    const original = fixture.storage.set.bind(fixture.storage);
    const set = vi.spyOn(fixture.storage, 'set').mockImplementation(async (...args) => {
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
      ).rejects.toMatchObject({ data: { reason: 'canvas_busy' } });
      await expect(
        fixture.service.describe(handle.canvas_id, {}, fixture.ctx),
      ).rejects.toMatchObject({ data: { reason: 'canvas_busy' } });
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
      ).rejects.toMatchObject({ data: { reason: 'canvas_busy' } });
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
