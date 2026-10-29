/** @fileoverview Native staging, isolation and workload contracts. @module tests/services/canvas/canvas-service */
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POWER_LIMITS } from '@/config/server-config.js';
import {
  type CanvasService,
  createCanvasService,
  type ProducerLease,
} from '@/services/canvas/index.js';
import { PRODUCER_CAP_BYTES } from '@/services/canvas/producer-estimate.js';
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
    for (const rowLimit of [0, -1, 1.5])
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
    const retained = (
      await fixture.service.present(dataset(), handle.canvas_id, fixture.ctx, source)
    ).dataset!;
    expect(
      await fixture.service.drop(handle.canvas_id, { table: handle.table }, fixture.ctx),
    ).toMatchObject({ dropped: true });
    expect(
      await fixture.service.drop(handle.canvas_id, { table: handle.table }, fixture.ctx),
    ).toMatchObject({ dropped: false });
    expect(
      (await fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).tables.map(
        (item) => item.table,
      ),
    ).toEqual([retained.table]);
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
    await expect(fixture.service.describe(handle.canvas_id, {}, fixture.ctx)).rejects.toMatchObject(
      { data: { reason: 'canvas_not_found' } },
    );
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
  it.each([false, true])(
    'offers only available canvas-count recovery when drop is %s',
    async (dropEnabled) => {
      await fixture.close();
      fixture = await nativeFixture(dropEnabled);
      for (let i = 0; i < POWER_LIMITS.canvasesPerTenant; i++) await stage();
      await expect(stage()).rejects.toMatchObject({
        data: {
          reason: 'canvas_capacity_exhausted',
          recovery: {
            hint: dropEnabled
              ? 'Reuse an explicit live canvas_id, drop all tables from a canvas, or wait for canvas expiry.'
              : 'Reuse an explicit live canvas_id, or wait for canvas expiry.',
          },
        },
      });
    },
  );
  it('refuses disabled native staging and over-bound rows without partial success', async () => {
    const service = createCanvasService({
      storage: fixture.storage,
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
    try {
      /** Without a split planner no call list exists, and the message still says so. */
      const refusal = await service
        .present(dataset(), undefined, fixture.ctx, source)
        .catch((error: McpError) => error);
      expect(refusal).toMatchObject({ data: { reason: 'canvas_required', calls: [] } });
      expect((refusal as McpError).message).toMatch(/\n\ninlineRows: \d+\n\ncalls: \[\]$/);
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
});

describe('producer admission', () => {
  const MiB = 1024 * 1024;
  let service: CanvasService;
  beforeEach(() => {
    vi.useFakeTimers();
    service = createCanvasService({
      storage: createInMemoryStorage(),
      config: { maxCanvasesPerProcess: 8, dataframeDropEnabled: false },
    });
  });
  afterEach(async () => {
    await service.shutdown();
    vi.useRealTimers();
  });
  /** One producing call that runs until released or aborted, exposing its lease and outcome. */
  function call(estimate: number, ctx: Context = createMockContext()) {
    const gate = Promise.withResolvers<void>();
    const state: { lease?: ProducerLease; signal?: AbortSignal; ran: boolean } = { ran: false };
    const outcome = service
      .withProducer(estimate, ctx, async (runCtx, lease) => {
        state.ran = true;
        state.lease = lease;
        state.signal = runCtx.signal;
        runCtx.signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          gate.promise.then(resolve);
          runCtx.signal.addEventListener('abort', () => reject(runCtx.signal.reason), {
            once: true,
          });
        });
        return estimate;
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    return {
      state,
      outcome,
      release: () => gate.resolve(),
      get settled() {
        return settled;
      },
    };
  }
  const tick = () => vi.advanceTimersByTimeAsync(0);

  it('runs two overlapping small calls at once and admits the rest in arrival order as each returns', async () => {
    const calls = Array.from({ length: 4 }, () => call(64 * 1024));
    await tick();
    expect(calls.map((item) => item.state.ran)).toEqual([true, true, false, false]);
    calls[0]!.release();
    expect(await calls[0]!.outcome).toEqual({ value: 64 * 1024 });
    await tick();
    expect(calls.map((item) => item.state.ran)).toEqual([true, true, true, false]);
    calls[1]!.release();
    await tick();
    expect(calls[3]!.state.ran).toBe(true);
    calls[2]!.release();
    calls[3]!.release();
    for (const item of calls) expect(await item.outcome).toEqual({ value: 64 * 1024 });
  });

  it('admits a small call beside an in-flight large call only while both estimates fit the tenant ceiling', async () => {
    const regional = call(PRODUCER_CAP_BYTES.single);
    const small = call(MiB);
    await tick();
    expect([regional.state.ran, small.state.ran]).toEqual([true, true]);
    regional.release();
    small.release();
    await Promise.all([regional.outcome, small.outcome]);
    const comparison = call(PRODUCER_CAP_BYTES.comparison);
    const sameTenant = call(MiB);
    const otherTenant = call(MiB, createMockContext({ tenantId: 'other' }));
    await tick();
    expect([comparison.state.ran, sameTenant.state.ran, otherTenant.state.ran]).toEqual([
      true,
      false,
      true,
    ]);
    comparison.release();
    otherTenant.release();
    await tick();
    expect(sameTenant.state.ran).toBe(true);
    sameTenant.release();
    expect(await sameTenant.outcome).toEqual({ value: MiB });
  });

  it('refuses a small call still waiting behind a worst-case call after exactly the admission wait', async () => {
    const worst = call(PRODUCER_CAP_BYTES.comparison);
    const small = call(MiB);
    await vi.advanceTimersByTimeAsync(POWER_LIMITS.queueWaitMs - 1);
    expect(small.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { error } = (await small.outcome) as { error: McpError };
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({
      reason: 'producer_capacity_exhausted',
      retryable: true,
      recovery: {
        hint: 'Another data call is in flight and holds the capacity this call needs; retry when it returns.',
      },
    });
    expect(small.state.ran).toBe(false);
    worst.release();
    expect(await worst.outcome).toEqual({ value: PRODUCER_CAP_BYTES.comparison });
  });

  it('rejects an aborted waiter with its own reason and leaves no reservation, as does an abort right after admission', async () => {
    const [first, second] = [call(MiB), call(MiB)];
    const waiting = new AbortController();
    const aborted = call(MiB, createMockContext({ signal: waiting.signal }));
    const racing = new AbortController();
    const raced = call(MiB, createMockContext({ signal: racing.signal }));
    await tick();
    waiting.abort();
    await tick();
    expect(await aborted.outcome).toMatchObject({ error: { name: 'AbortError' } });
    expect(aborted.state.ran).toBe(false);
    first.release();
    await first.outcome;
    expect(raced.state.ran).toBe(true);
    racing.abort();
    expect(await raced.outcome).toMatchObject({ error: { name: 'AbortError' } });
    second.release();
    await Promise.all([first.outcome, second.outcome]);
    const whole = call(POWER_LIMITS.tenantInflightBytes);
    await tick();
    expect(whole.state.ran).toBe(true);
    whole.release();
    expect(await whole.outcome).toEqual({ value: POWER_LIMITS.tenantInflightBytes });
  });

  it('grows a reservation atomically and refuses growth past the tenant ceiling', async () => {
    const growing = call(MiB);
    await tick();
    const lease = growing.state.lease!;
    lease.rowBytes(40 * MiB);
    lease.bodyBytes(10 * MiB);
    const blocked = call(20 * MiB);
    const other = call(60 * MiB, createMockContext({ tenantId: 'other' }));
    await tick();
    expect([blocked.state.ran, other.state.ran]).toEqual([false, true]);
    let refusal: unknown;
    try {
      lease.rowBytes(60 * MiB);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'producer_capacity_exhausted', retryable: true },
    });
    expect(growing.state.signal?.aborted).toBe(true);
    expect(growing.state.signal?.reason).toBe(refusal);
    expect(await growing.outcome).toEqual({ error: refusal });
    await tick();
    expect(blocked.state.ran).toBe(true);
    blocked.release();
    other.release();
    await Promise.all([blocked.outcome, other.outcome]);
  });

  it('starts the call deadline at tool entry, so admission wait is subtracted from it', async () => {
    const [first, second] = [call(MiB), call(MiB)];
    const late = call(MiB);
    await vi.advanceTimersByTimeAsync(10_000);
    first.release();
    await tick();
    expect(late.state.lease?.remainingMs()).toBe(POWER_LIMITS.deadlineMs - 10_000);
    await vi.advanceTimersByTimeAsync(POWER_LIMITS.deadlineMs - 10_000 - 1);
    expect(late.state.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(late.state.signal?.aborted).toBe(true);
    expect(await late.outcome).toMatchObject({ error: { name: 'TimeoutError' } });
    second.release();
    await second.outcome;
  });

  it('admits a worst-case comparison waiting behind a steady stream of overlapping small calls before its admission wait ends', async () => {
    /** Each small call runs 1 s and a new one arrives every 500 ms, so one is always in flight. */
    const stream = [call(64 * 1024)];
    const worst = call(PRODUCER_CAP_BYTES.comparison);
    await tick();
    expect([stream[0]!.state.ran, worst.state.ran]).toEqual([true, false]);
    let admittedAt: number | undefined;
    for (let at = 500; at < POWER_LIMITS.queueWaitMs; at += 500) {
      await vi.advanceTimersByTimeAsync(500);
      stream.at(-2)?.release();
      await tick();
      if (worst.state.ran) {
        admittedAt = at;
        break;
      }
      stream.push(call(64 * 1024));
      await tick();
    }
    expect(worst.state.ran).toBe(true);
    /** Arrivals overtake a fresh waiter; once it has waited its overtake window they queue behind it. */
    expect(stream[1]!.state.ran).toBe(true);
    expect(admittedAt).toBe(POWER_LIMITS.queueOvertakeMs + 500);
    expect(stream.at(-1)!.state.ran).toBe(false);
    worst.release();
    await tick();
    expect(stream.at(-1)!.state.ran).toBe(true);
    for (const item of stream) item.release();
    expect(await worst.outcome).toEqual({ value: PRODUCER_CAP_BYTES.comparison });
    await Promise.all(stream.map((item) => item.outcome));
  });

  it('lets a queued call that fits overtake a waiting call only inside its overtake window', async () => {
    const holder = call(20 * MiB);
    const first = call(MiB);
    /** 20 MiB in flight leaves the tenant too little for a single-site worst case. */
    const worst = call(PRODUCER_CAP_BYTES.single);
    const early = call(MiB);
    await tick();
    expect([holder, first, worst, early].map((item) => item.state.ran)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    first.release();
    await tick();
    expect([worst.state.ran, early.state.ran]).toEqual([false, true]);
    const late = call(MiB);
    await vi.advanceTimersByTimeAsync(POWER_LIMITS.queueOvertakeMs - 1_000);
    early.release();
    await tick();
    expect([worst.state.ran, late.state.ran]).toEqual([false, false]);
    holder.release();
    await tick();
    expect([worst.state.ran, late.state.ran]).toEqual([true, true]);
    for (const item of [worst, late]) item.release();
    await Promise.all([holder, first, worst, early, late].map((item) => item.outcome));
  });

  it.each([
    ['times out', () => vi.advanceTimersByTimeAsync(POWER_LIMITS.queueWaitMs - 6_000)],
    ['is aborted', (abort: AbortController) => Promise.resolve(abort.abort())],
  ] as const)(
    'admits a queued call that fits once the waiter it queued behind %s',
    async (_exit, leave) => {
      /** 48 MiB in flight: a second single-site worst case waits, a 1 MiB call fits. */
      const holder = call(PRODUCER_CAP_BYTES.single);
      const abort = new AbortController();
      const blocked = call(PRODUCER_CAP_BYTES.single, createMockContext({ signal: abort.signal }));
      await vi.advanceTimersByTimeAsync(6_000);
      const small = call(MiB);
      await tick();
      expect(small.state.ran).toBe(false);
      await leave(abort);
      await blocked.outcome;
      await tick();
      expect(small.state.ran).toBe(true);
      holder.release();
      small.release();
      expect(await small.outcome).toEqual({ value: MiB });
    },
  );

  it('rejects every waiter on shutdown, aborts admitted calls and refuses new work', async () => {
    const admitted = [call(MiB), call(MiB)];
    const waiters = [call(MiB), call(MiB)];
    await tick();
    await service.shutdown();
    await Promise.all([...admitted, ...waiters].map((item) => item.outcome));
    /** Waiter admission timers and admitted call deadlines are all cleared. */
    expect(vi.getTimerCount()).toBe(0);
    for (const item of waiters) {
      expect(await item.outcome).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'Analytical workspace is shutting down.',
        },
      });
      expect(item.state.ran).toBe(false);
    }
    for (const item of admitted)
      expect(await item.outcome).toMatchObject({ error: expect.any(Error) });
    await expect(
      service.withProducer(MiB, createMockContext(), async () => 1),
    ).rejects.toMatchObject({ message: 'Analytical workspace is shutting down.' });
    await expect(
      service.present(dataset(), undefined, createMockContext(), 'nasa_power_get_timeseries'),
    ).rejects.toMatchObject({ message: 'Analytical workspace is shutting down.' });
  });
});
