/** @fileoverview Native staging, isolation and workload contracts. @module tests/services/canvas/canvas-service */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POWER_LIMITS } from '@/config/server-config.js';
import { createCanvasService } from '@/services/canvas/index.js';
import { dataset, nativeFixture } from './fixture.js';

describe('CanvasService with DuckDB', () => {
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

  it('keeps small and empty results inline without acquiring a canvas', async () => {
    for (const count of [0, 1]) {
      const data = dataset(count);
      expect(await fixture.service.present(data, undefined, fixture.ctx, source)).toEqual({
        ...data,
        rowCount: count,
        dataset: null,
      });
    }
    expect(fixture.canvas.countForTenant(fixture.ctx)).toBe(0);
  });
  it('stages every row with explicit scientific types and whole-row preview', async () => {
    const data = dataset();
    const result = await stage();
    expect(result.rowCount).toBe(400);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(400);
    expect(result.rows).toEqual(data.rows.slice(0, result.rows.length));
    expect(JSON.stringify(result.rows).length).toBeLessThanOrEqual(POWER_LIMITS.inlineCharacters);
    const handle = result.dataset!;
    expect(handle.rowCount).toBe(400);
    const described = await fixture.service.describe(handle.canvas_id, {}, fixture.ctx);
    expect(described.tables).toHaveLength(1);
    expect(described.tables[0]?.columns).toEqual(
      expect.arrayContaining([
        { name: 'year', type: 'INTEGER', nullable: true },
        { name: 'month', type: 'INTEGER', nullable: true },
        { name: 'hour', type: 'INTEGER', nullable: true },
        { name: 'periodKey', type: 'VARCHAR', nullable: false },
        { name: 'periodKind', type: 'VARCHAR', nullable: false },
      ]),
    );
    expect(described.tables[0]).toMatchObject({
      rowCount: 400,
      columns: expect.arrayContaining([
        { name: 'T2M', type: 'DOUBLE', nullable: true, units: 'C', valueKind: 'number' },
        {
          name: 'ORT',
          type: 'VARCHAR',
          nullable: true,
          units: 'direction',
          valueKind: 'orientation',
        },
      ]),
      provenance: {
        sourceTool: source,
        envelope: { metadata: data.metadata, parameters: data.parameters },
      },
    });
    const queried = await fixture.service.query(
      handle.canvas_id,
      { sql: `SELECT T2M, ORT FROM ${handle.table} WHERE T2M > 0 ORDER BY T2M`, rowLimit: 1000 },
      fixture.ctx,
    );
    expect(queried.rows).toHaveLength(200);
    expect(queried.rows[0]).toEqual({ T2M: 200.125, ORT: 'south | ``` facing' });
    expect(queried.rows.at(-1)?.T2M).toBe(399.125);
  });
  it('mints a fresh token on every omitted-token spill, and reuses only explicit tokens', async () => {
    const one = (await stage()).dataset!;
    const two = (await stage()).dataset!;
    expect(one.canvas_id).not.toBe(two.canvas_id);
    const another = await fixture.service.present(dataset(), one.canvas_id, fixture.ctx, source);
    expect(another.dataset?.canvas_id).toBe(one.canvas_id);
    expect((await fixture.service.describe(one.canvas_id, {}, fixture.ctx)).tables).toHaveLength(2);
    expect((await fixture.service.describe(two.canvas_id, {}, fixture.ctx)).tables).toHaveLength(1);
    await expect(
      fixture.service.query(two.canvas_id, { sql: `SELECT * FROM ${one.table}` }, fixture.ctx),
    ).rejects.toMatchObject({ data: { reason: 'missing_table' } });
  });
  it('stages comparison label as VARCHAR without coercing caller text', async () => {
    const data = dataset();
    const rows = data.rows.map((row) => ({ ...row, label: 'site | north\n``` literal' }));
    const result = await fixture.service.present(
      { ...data, rows },
      undefined,
      fixture.ctx,
      'nasa_power_compare_locations',
    );
    const handle = result.dataset!;
    expect(
      (await fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).tables[0]?.columns,
    ).toEqual(expect.arrayContaining([{ name: 'label', type: 'VARCHAR', nullable: true }]));
    expect(
      (
        await fixture.service.query(
          handle.canvas_id,
          { sql: `SELECT label FROM ${handle.table} LIMIT 1` },
          fixture.ctx,
        )
      ).rows,
    ).toEqual([{ label: 'site | north\n``` literal' }]);
  });
  it('requires a valid explicit capability under auth none and rejects wrong tenants uniformly', async () => {
    const handle = (await stage()).dataset!;
    const stranger = { ...fixture.ctx, tenantId: 'authenticated-other-tenant' };
    for (const ctx of [fixture.ctx, stranger]) {
      await expect(fixture.service.describe('abcdefghij', {}, ctx)).rejects.toMatchObject({
        data: { reason: 'canvas_not_found', recovery: { hint: expect.any(String) } },
      });
    }
    await expect(fixture.service.describe(handle.canvas_id, {}, stranger)).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
    await expect(
      fixture.service.present(dataset(), handle.canvas_id, stranger, source),
    ).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
    expect(
      (
        await fixture.service.describe(
          handle.canvas_id,
          {},
          { ...fixture.ctx, requestId: 'another-anonymous-request' },
        )
      ).tables,
    ).toHaveLength(1);
  });
  it('caps SQL rows accurately and returns an exact empty result beyond the end', async () => {
    const handle = (await stage()).dataset!;
    expect(
      await fixture.service.query(
        handle.canvas_id,
        { sql: `SELECT T2M FROM ${handle.table}`, rowLimit: 2 },
        fixture.ctx,
      ),
    ).toMatchObject({
      rows: expect.any(Array),
      shownCount: 2,
      truncated: true,
      countSemantics: 'materialized_prefix',
    });
    expect(
      await fixture.service.query(
        handle.canvas_id,
        { sql: `SELECT T2M FROM ${handle.table} OFFSET 400` },
        fixture.ctx,
      ),
    ).toMatchObject({
      rows: [],
      rowCount: 0,
      shownCount: 0,
      truncated: false,
      countSemantics: 'exact',
    });
    for (const rowLimit of [0, 1001, 1.5])
      await expect(
        fixture.service.query(handle.canvas_id, { sql: 'SELECT 1', rowLimit }, fixture.ctx),
      ).rejects.toMatchObject({ data: { reason: 'query_limit' } });
    await expect(
      fixture.service.query(handle.canvas_id, { sql: ' '.repeat(16385) }, fixture.ctx),
    ).rejects.toMatchObject({ data: { reason: 'query_limit' } });
    await expect(
      fixture.service.query(
        handle.canvas_id,
        { sql: `SELECT * FROM ${handle.table}`, rowLimit: 1000 },
        fixture.ctx,
      ),
    ).rejects.toMatchObject({ data: { reason: 'query_limit' } });
  });
  it.each([
    ['SELECT FROM', 'invalid_sql'],
    ['SELECT missing_column FROM TABLE_NAME', 'invalid_sql'],
    ['SELECT * FROM absent_table', 'missing_table'],
    ['SELECT 1; SELECT 2', 'multi_statement'],
    ['DROP TABLE TABLE_NAME', 'non_select_statement'],
    ['SELECT * FROM information_schema.tables', 'system_catalog_access'],
    ["SELECT current_setting('memory_limit')", 'denied_function'],
    ["SELECT * FROM read_csv('/etc/passwd')", 'denied_function'],
    ["SELECT * FROM '/etc/passwd'", 'missing_table'],
    ['SELECT CAST(ORT AS INTEGER) FROM TABLE_NAME WHERE ORT IS NOT NULL', 'sql_execution_error'],
  ])('classifies unsafe or invalid SQL: %s', async (sql, reason) => {
    const handle = (await stage()).dataset!;
    await expect(
      fixture.service.query(
        handle.canvas_id,
        { sql: sql.replaceAll('TABLE_NAME', handle.table) },
        fixture.ctx,
      ),
    ).rejects.toMatchObject({ data: { reason, recovery: { hint: expect.any(String) } } });
  });
  it('drops only the named table idempotently and removes its provenance', async () => {
    const handle = (await stage()).dataset!;
    expect(
      await fixture.service.drop(handle.canvas_id, { table: handle.table }, fixture.ctx),
    ).toMatchObject({ dropped: true });
    expect(
      await fixture.service.drop(handle.canvas_id, { table: handle.table }, fixture.ctx),
    ).toMatchObject({ dropped: false });
    expect((await fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).tables).toEqual([]);
    await expect(
      fixture.service.describe(handle.canvas_id, { table: handle.table }, fixture.ctx),
    ).rejects.toMatchObject({ data: { reason: 'missing_table' } });
    await expect(
      fixture.service.drop('abcdefghij', { table: handle.table }, fixture.ctx),
    ).rejects.toMatchObject({
      data: {
        reason: 'canvas_not_found',
        recovery: { hint: 'The canvas has expired or is absent; there is nothing left to remove.' },
      },
    });
  });
  it('retains table TTL through describe, slides it on query, and reconciles expired metadata', async () => {
    const handle = (await stage()).dataset!;
    const first = await fixture.service.describe(handle.canvas_id, {}, fixture.ctx);
    fixture.advance(10 * 60_000);
    expect(
      (await fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).tables[0]?.expiresAt,
    ).toBe(first.tables[0]?.expiresAt);
    await fixture.service.query(
      handle.canvas_id,
      { sql: `SELECT T2M FROM ${handle.table} LIMIT 1` },
      fixture.ctx,
    );
    expect(
      Date.parse(
        (await fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).tables[0]!.expiresAt!,
      ),
    ).toBeGreaterThan(Date.parse(first.tables[0]!.expiresAt!));
    fixture.advance(POWER_LIMITS.tableTtlMs + 1);
    await fixture.registry.sweep();
    await fixture.service.reconcile();
    expect((await fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).tables).toEqual([]);
    fixture.advance(POWER_LIMITS.canvasAbsoluteTtlMs);
    await fixture.service.reconcile();
    await expect(fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).rejects.toMatchObject(
      { data: { reason: 'canvas_not_found' } },
    );
  });
  it('enforces table and tenant canvas caps without evicting live tables', async () => {
    const handle = (await stage()).dataset!;
    for (let i = 1; i < POWER_LIMITS.tablesPerCanvas; i++)
      await fixture.service.present(dataset(), handle.canvas_id, fixture.ctx, source);
    await expect(
      fixture.service.present(dataset(), handle.canvas_id, fixture.ctx, source),
    ).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted', retryable: true } });
    for (let i = 1; i < POWER_LIMITS.canvasesPerTenant; i++) await stage();
    await expect(stage()).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    expect((await fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).tables).toHaveLength(
      8,
    );
  });
  it('refuses disabled native staging and over-bound rows without partial success', async () => {
    const service = createCanvasService({
      storage: fixture.storage,
      config: { dataframeDropEnabled: false },
    });
    try {
      await expect(
        service.present(dataset(), undefined, fixture.ctx, source),
      ).rejects.toMatchObject({ data: { reason: 'canvas_required' } });
      await expect(service.describe('abcdefghij', {}, fixture.ctx)).rejects.toMatchObject({
        data: { reason: 'canvas_unavailable' },
      });
      await expect(service.drop('abcdefghij', { table: 'any' }, fixture.ctx)).rejects.toMatchObject(
        { message: 'Explicit dataframe removal is disabled.' },
      );
      const data = dataset(1);
      data.rows = Array(250001).fill(data.rows[0]);
      await expect(service.present(data, undefined, fixture.ctx, source)).rejects.toMatchObject({
        data: { reason: 'dataset_limit' },
      });
    } finally {
      await service.shutdown();
    }
  });
  it('holds producer admissions atomically and shutdown aborts and settles them', async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = fixture.service
      .withProducer('single', fixture.ctx, async (ctx) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        });
      })
      .catch((error: unknown) => error);
    await began;
    await expect(
      fixture.service.withProducer('single', fixture.ctx, async () => 1),
    ).rejects.toMatchObject({ data: { reason: 'canvas_capacity_exhausted' } });
    expect(
      await fixture.service.withProducer(
        'single',
        createMockContext({ tenantId: 'other' }),
        async () => 2,
      ),
    ).toBe(2);
    await fixture.service.shutdown();
    expect(await pending).toBeInstanceOf(Error);
    await expect(stage()).rejects.toMatchObject({
      message: 'Analytical workspace is shutting down.',
    });
  });
});
